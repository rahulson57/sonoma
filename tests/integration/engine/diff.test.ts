/**
 * SPEC-006 diff(a, b): four parts — state (JSON Patch), workspace (`git diff --name-status`), ledger ranges
 * and side effects.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import type { JsonPatch } from '../../../src/engine/index.js';
import { engineFixture, git, parseNameStatus, refOf, removeFile, writeFiles } from './support.js';

/** Minimal RFC 6902 apply for add/remove/replace, enough to prove the state patch turns a into b. */
function applyPatch(document: unknown, patch: JsonPatch): unknown {
  const root: Record<string, unknown> = { value: structuredClone(document) };
  for (const operation of patch) {
    const tokens = ['value', ...operation.path.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))];
    let parent = root;
    for (const token of tokens.slice(0, -1)) parent = parent[token] as Record<string, unknown>;
    const last = tokens.at(-1) ?? 'value';
    if (operation.op === 'remove') delete parent[last];
    else parent[last] = operation.value;
  }
  return root['value'];
}

describe('diff()', () => {
  it('diff(a, b) returns all four parts and the workspace part equals git diff --name-status <a> <b>', async () => {
    const fx = await engineFixture({ files: { 'keep.txt': 'keep\n', 'mod.txt': 'm1\n', 'del.txt': 'this file goes away\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const id = run.run_id;
      const c1 = await fx.engine.checkpoint(id);

      await fx.engine.record([
        { run_id: id, type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: 'se_1', type: 'kv.put', target: 'cache/session' } },
        { run_id: id, type: 'side_effect.committed', actor: 'runtime', payload: { side_effect_id: 'se_1' } },
        { run_id: id, type: 'model.responded', actor: 'runtime', payload: { request_id: 'req_1', usage: { input_tokens: 120, output_tokens: 30 } } },
      ]);
      await writeFiles(fx.repo.dir, { 'mod.txt': 'm2\n', 'add.txt': 'brand new\n', 'nested/deep/x.txt': 'x\n' });
      await removeFile(fx.repo.dir, 'del.txt');
      const c2 = await fx.engine.checkpoint(id);

      const d = await fx.engine.diff(refOf(c1), refOf(c2));
      expect(Object.keys(d).sort()).toEqual(['ledger', 'sideEffects', 'state', 'workspace']);

      // workspace
      const expected = parseNameStatus(await git(fx.repo.dir, ['diff', '--name-status', c1.workspace_commit, c2.workspace_commit]));
      expect(d.workspace).toEqual(expected);
      expect(d.workspace.map((entry) => `${entry.status} ${entry.path}`)).toEqual(['A add.txt', 'D del.txt', 'M mod.txt', 'A nested/deep/x.txt']);

      // state
      const stateA = await fx.backend.getState({ run_id: id, checkpoint_id: 'c_1' });
      const stateB = await fx.backend.getState({ run_id: id, checkpoint_id: 'c_2' });
      expect(applyPatch(stateA, d.state)).toEqual(stateB);
      expect(d.state).toContainEqual({ op: 'replace', path: '/checkpoint_id', value: 'c_2' });
      expect(d.state).toContainEqual({ op: 'replace', path: '/usage/input_tokens', value: 120 });

      // ledger + side effects
      expect(d.ledger).toEqual({ a: [c1.ledger_seq, c1.ledger_seq], b: [c1.ledger_seq, c2.ledger_seq] });
      expect(d.sideEffects).toHaveLength(1);
      expect(d.sideEffects[0]).toMatchObject({ type: 'kv.put', target: 'cache/session', reversibility: 'irreversible' });

      // reversed
      const r = await fx.engine.diff(refOf(c2), refOf(c1));
      expect(r.workspace).toEqual(parseNameStatus(await git(fx.repo.dir, ['diff', '--name-status', c2.workspace_commit, c1.workspace_commit])));
      expect(applyPatch(stateB, r.state)).toEqual(stateA);
      expect(r.ledger).toEqual({ a: [c1.ledger_seq, c2.ledger_seq], b: [c1.ledger_seq, c1.ledger_seq] });

      // across a fork: the common ancestor is c_1 of the source run; the fork's own range starts at 0.
      const forked = await fx.engine.fork(refOf(c1));
      await writeFiles(fx.engine.worktreePath(forked.run_id), { 'fork.txt': 'fork\n', 'mod.txt': 'fork edit\n' });
      const f1 = await fx.engine.checkpoint(forked.run_id);
      const cross = await fx.engine.diff(refOf(c2), refOf(f1));
      expect(cross.workspace).toEqual(parseNameStatus(await git(fx.repo.dir, ['diff', '--name-status', c2.workspace_commit, f1.workspace_commit])));
      expect(cross.ledger).toEqual({ a: [c1.ledger_seq, c2.ledger_seq], b: [0, f1.ledger_seq] });
      expect(cross.sideEffects.map((effect) => effect.type)).toEqual(['kv.put']);
    } finally {
      await fx.cleanup();
    }
  });
});
