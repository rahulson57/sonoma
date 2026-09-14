/**
 * SPEC-006 rollback(ref): managed reversible state only (workspace + the run's current state) goes back to
 * `ref`; every side effect recorded after it is returned as a warning; `agent.rolled_back` is emitted.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import type { LedgerEventDraft } from '../../../src/model/types.js';
import { allEvents, engineFixture, git, refOf, treeOf, writeFiles } from './support.js';

function sideEffect(runId: string, id: string, request: Record<string, unknown>, commit: Record<string, unknown> = {}): LedgerEventDraft[] {
  return [
    { run_id: runId, type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: id, ...request } },
    { run_id: runId, type: 'side_effect.committed', actor: 'runtime', payload: { side_effect_id: id, ...commit } },
  ];
}

describe('rollback()', () => {
  it('rollback(c_3) after side effects recorded at c_4 and c_5 restores workspace and state to c_3, returns exactly those side effects as warnings, and emits agent.rolled_back', async () => {
    const fx = await engineFixture({ files: { 'app.txt': 'v0\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const id = run.run_id;
      await writeFiles(fx.repo.dir, { 'app.txt': 'v1\n' });
      await fx.engine.checkpoint(id);
      await writeFiles(fx.repo.dir, { 'app.txt': 'v2\n' });
      await fx.engine.checkpoint(id);
      // Recorded before c_3: not a warning when rolling back to c_3.
      await fx.engine.record(sideEffect(id, 'se_early', { type: 'fs.chmod', target: 'ops/early' }));
      await writeFiles(fx.repo.dir, { 'app.txt': 'v3\n' });
      const c3 = await fx.engine.checkpoint(id);

      await fx.engine.record(
        sideEffect(
          id,
          'se_4',
          { type: 'http.post', target: 'https://deploy.example.invalid/releases', request_hash: '1'.repeat(64), reversibility: 'compensatable' },
          { response_hash: '2'.repeat(64) },
        ),
      );
      await writeFiles(fx.repo.dir, { 'extra.txt': 'added at c_4\n' });
      const c4 = await fx.engine.checkpoint(id);
      await fx.engine.record(sideEffect(id, 'se_5', { type: 'email.send', target: 'ops@example.invalid' }, { status: 'sent' }));
      await writeFiles(fx.repo.dir, { 'app.txt': 'v5\n' });
      const c5 = await fx.engine.checkpoint(id);
      expect([c3.checkpoint_id, c4.checkpoint_id, c5.checkpoint_id]).toEqual(['c_3', 'c_4', 'c_5']);

      const result = await fx.engine.rollback(refOf(c3));

      expect(result.restored).toEqual(c3);
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toEqual({
        type: 'http.post',
        target: 'https://deploy.example.invalid/releases',
        request_hash: '1'.repeat(64),
        response_hash: '2'.repeat(64),
        reversibility: 'compensatable',
      });
      // No reversibility recorded: SPEC-004 default. No hashes recorded: hashes of the recorded payloads.
      expect(result.warnings[1]).toMatchObject({ type: 'email.send', target: 'ops@example.invalid', reversibility: 'irreversible' });
      expect(result.warnings[1]?.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.warnings[1]?.response_hash).toMatch(/^[0-9a-f]{64}$/);

      // Workspace restored to c_3 in the run's execution worktree.
      const worktree = fx.engine.worktreePath(id);
      expect((await git(worktree, ['rev-parse', 'HEAD'])).trim()).toBe(c3.workspace_commit);
      expect(await git(worktree, ['status', '--porcelain'])).toBe('');
      expect(await readFile(path.join(worktree, 'app.txt'), 'utf8')).toBe('v3\n');
      await expect(access(path.join(worktree, 'extra.txt'))).rejects.toThrow();

      const events = await allEvents(fx.backend, id);
      expect(events.at(-1)).toMatchObject({
        type: 'agent.rolled_back',
        payload: { checkpoint_id: 'c_3', ledger_seq: c3.ledger_seq, workspace_commit: c3.workspace_commit, side_effect_warnings: 2 },
      });

      // State restored: the run continues from c_3, in the restored workspace.
      expect(await fx.engine.workspaceDir(id)).toBe(worktree);
      const c6 = await fx.engine.checkpoint(id);
      expect(c6).toMatchObject({ checkpoint_id: 'c_6', parent_checkpoint_id: 'c_3' });
      expect(await treeOf(fx.repo.dir, c6.workspace_commit)).toBe(await treeOf(fx.repo.dir, c3.workspace_commit));

      // A second rollback into the existing worktree drops untracked work but keeps user-supplied secret files.
      await writeFiles(worktree, { '.env': 'LOCAL_ONLY=1\n', 'junk.txt': 'scratch\n', 'app.txt': 'dirty\n' });
      const again = await fx.engine.rollback(refOf(c3));
      expect(again.warnings.map((warning) => warning.type)).toEqual(['http.post', 'email.send']);
      expect(await readFile(path.join(worktree, 'app.txt'), 'utf8')).toBe('v3\n');
      await expect(access(path.join(worktree, 'junk.txt'))).rejects.toThrow();
      expect(await readFile(path.join(worktree, '.env'), 'utf8')).toBe('LOCAL_ONLY=1\n');
      expect(await git(worktree, ['status', '--porcelain'])).toBe('?? .env\n');
    } finally {
      await fx.cleanup();
    }
  });

  it('DEC-031: checkpoint() after rollback(c_1) does not record call_edit as completed but still records se_email as completed', async () => {
    const fx = await engineFixture({ files: { 'app.txt': 'v0\n' } });
    try {
      const id = (await fx.engine.startRun({ agent: 'claude-code' })).run_id;
      const tool = (type: 'tool.requested' | 'tool.completed', callId: string): LedgerEventDraft =>
        ({ run_id: id, type, actor: type === 'tool.requested' ? 'agent' : 'runtime', payload: { tool_call_id: callId } }) as LedgerEventDraft;

      await fx.engine.record([tool('tool.requested', 'call_read'), tool('tool.completed', 'call_read')]);
      const c1 = await fx.engine.checkpoint(id);
      await writeFiles(fx.repo.dir, { 'app.txt': 'v2\n' });
      await fx.engine.record([
        tool('tool.requested', 'call_edit'),
        tool('tool.completed', 'call_edit'),
        ...sideEffect(id, 'se_email', { type: 'email.send', target: 'ops@example.invalid', reversibility: 'irreversible' }, { status: 'sent' }),
      ]);
      await fx.engine.checkpoint(id);

      const result = await fx.engine.rollback(refOf(c1));
      expect(result.warnings.map((warning) => warning.type)).toEqual(['email.send']);
      await writeFiles(fx.engine.worktreePath(id), { 'app.txt': 'v3\n' });
      const c3 = await fx.engine.checkpoint(id);

      expect(c3).toMatchObject({ checkpoint_id: 'c_3', parent_checkpoint_id: 'c_1' });
      const state3 = await fx.backend.getState({ run_id: id, checkpoint_id: 'c_3' });
      expect(state3.pending_intent.map((intent) => [intent.kind, intent.intent_id, intent.status])).toEqual([
        ['tool', 'call_read', 'completed'],
        ['side_effect', 'se_email', 'completed'],
      ]);
      expect(state3.pending_intent.find((intent) => intent.intent_id === 'se_email')?.requested_seq).toBeGreaterThan(c1.ledger_seq);
    } finally {
      await fx.cleanup();
    }
  });
});
