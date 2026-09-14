/**
 * SPEC-006 checkpoint(): state blob + sanitized workspace commit + ledger cursor, atomically, with
 * `checkpoint.created` emitted through storage.
 */
import { chmod, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Git-backed engine tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { isEngineError } from '../../../src/engine/index.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { allEvents, engineFixture, git, removeFile, sha256, treeOf, treePaths, writeFiles } from './support.js';

describe('checkpoint()', () => {
  it('produces a Checkpoint whose workspace_commit resolves under refs/checkpoints/<run>/<ckpt>, whose state_hash matches the stored blob, and whose ledger_seq equals the seq of its checkpoint.created event', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n', 'src/app.ts': 'export const v = 1;\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      await fx.engine.record([{ run_id: run.run_id, type: 'agent.started', actor: 'runtime', payload: {} }]);
      const cp = await fx.engine.checkpoint(run.run_id);

      expect(cp).toMatchObject({ run_id: run.run_id, checkpoint_id: 'c_1', parent_checkpoint_id: null, label: null });
      expect((await git(fx.repo.dir, ['rev-parse', `refs/checkpoints/${run.run_id}/${cp.checkpoint_id}`])).trim()).toBe(cp.workspace_commit);
      // The store (.ckpt) and .git are never part of the workspace tree.
      expect(await treePaths(fx.repo.dir, cp.workspace_commit)).toEqual(['README.md', 'src/app.ts']);

      const blob = await readFile(path.join(fx.repo.dir, '.ckpt', 'objects', 'sha256', cp.state_hash.slice(0, 2), cp.state_hash));
      expect(sha256(blob)).toBe(cp.state_hash);
      expect(cp.state_blob).toEqual({ sha256: cp.state_hash, size: blob.byteLength });
      const state = await fx.backend.getState({ run_id: run.run_id, checkpoint_id: cp.checkpoint_id });
      expect(sha256(canonicalJSON(state))).toBe(cp.state_hash);
      expect(state).toMatchObject({ checkpoint_id: 'c_1', workspace_commit: cp.workspace_commit, ledger_seq: cp.ledger_seq });

      const events = await allEvents(fx.backend, run.run_id);
      const created = events.filter((event) => event.type === 'checkpoint.created');
      expect(created).toHaveLength(1);
      expect(created[0]?.seq).toBe(cp.ledger_seq);
      expect(created[0]?.payload).toMatchObject({ checkpoint_id: 'c_1', workspace_commit: cp.workspace_commit, ledger_seq: cp.ledger_seq });
      expect(events.map((event) => event.type)).toEqual(['run.created', 'agent.started', 'checkpoint.created']);
    } finally {
      await fx.cleanup();
    }
  });

  it('builds later checkpoints on their parent from the workspace delta: modified, added, deleted, executable and symlink entries', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n', 'src/app.ts': 'export const v = 1;\n', 'docs/old.md': 'old\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const c1 = await fx.engine.checkpoint(run.run_id);

      await writeFiles(fx.repo.dir, { 'src/app.ts': 'export const v = 2;\n', 'docs/new.md': 'new\n', 'bin/run.sh': '#!/bin/sh\necho hi\n' });
      await chmod(path.join(fx.repo.dir, 'bin', 'run.sh'), 0o755);
      await symlink('src/app.ts', path.join(fx.repo.dir, 'app-link'));
      await removeFile(fx.repo.dir, 'docs/old.md');
      const c2 = await fx.engine.checkpoint(run.run_id);

      expect(c2).toMatchObject({ checkpoint_id: 'c_2', parent_checkpoint_id: 'c_1' });
      expect((await git(fx.repo.dir, ['rev-parse', `${c2.workspace_commit}^`])).trim()).toBe(c1.workspace_commit);
      const modes = Object.fromEntries(
        (await git(fx.repo.dir, ['ls-tree', '-r', c2.workspace_commit]))
          .trim()
          .split('\n')
          .map((line) => [line.slice(line.indexOf('\t') + 1), line.split(' ')[0]]),
      );
      expect(modes).toEqual({
        'README.md': '100644',
        'app-link': '120000',
        'bin/run.sh': '100755',
        'docs/new.md': '100644',
        'src/app.ts': '100644',
      });
      expect(await git(fx.repo.dir, ['show', `${c2.workspace_commit}:src/app.ts`])).toBe('export const v = 2;\n');
      expect(await git(fx.repo.dir, ['show', `${c2.workspace_commit}:app-link`])).toBe('src/app.ts');

      // Nothing changed: same tree, next checkpoint still chains to its parent.
      const c3 = await fx.engine.checkpoint(run.run_id);
      expect(c3).toMatchObject({ checkpoint_id: 'c_3', parent_checkpoint_id: 'c_2' });
      expect(await treeOf(fx.repo.dir, c3.workspace_commit)).toBe(await treeOf(fx.repo.dir, c2.workspace_commit));

      // A later edit after the cached checkpoint is still picked up.
      await writeFiles(fx.repo.dir, { 'src/app.ts': 'export const v = 4;\n' });
      const c4 = await fx.engine.checkpoint(run.run_id);
      expect(await git(fx.repo.dir, ['show', `${c4.workspace_commit}:src/app.ts`])).toBe('export const v = 4;\n');
      expect((await fx.backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual(['c_1', 'c_2', 'c_3', 'c_4']);
    } finally {
      await fx.cleanup();
    }
  });

  it('leaves a file over the size limit out of the tree and records workspace.file_skipped for it', async () => {
    const fx = await engineFixture({ files: { 'small.txt': 'ok\n' }, engine: { maxFileBytes: 64 } });
    try {
      await writeFiles(fx.repo.dir, { 'assets/big.bin': Buffer.alloc(65, 7) });
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const cp = await fx.engine.checkpoint(run.run_id);

      expect(await treePaths(fx.repo.dir, cp.workspace_commit)).toEqual(['small.txt']);
      const skipped = (await allEvents(fx.backend, run.run_id)).filter((event) => event.type === 'workspace.file_skipped');
      expect(skipped.map((event) => event.payload)).toEqual([{ path: 'assets/big.bin', size: 65, reason: 'too_large', limit_bytes: 64 }]);
      expect(skipped[0]?.seq).toBeLessThan(cp.ledger_seq);
    } finally {
      await fx.cleanup();
    }
  });

  it('refuses observations that use an engine- or storage-owned event type', async () => {
    const fx = await engineFixture();
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      for (const type of ['run.created', 'checkpoint.created', 'agent.resumed', 'agent.forked', 'agent.rolled_back'] as const) {
        await expect(fx.engine.record([{ run_id: run.run_id, type, actor: 'agent', payload: {} }])).rejects.toSatisfy((err: unknown) =>
          isEngineError(err, 'ERR_RESERVED_EVENT'),
        );
      }
      expect((await allEvents(fx.backend, run.run_id)).map((event) => event.type)).toEqual(['run.created']);
    } finally {
      await fx.cleanup();
    }
  });
});
