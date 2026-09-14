/**
 * SPEC-006 fork(ref): a new run with parent_run_id + forked_from_checkpoint whose workspace starts at the
 * source workspace_commit; emits `agent.forked`; never mutates the source run.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { allEvents, engineFixture, git, refOf, treeOf, treePaths, writeFiles } from './support.js';

describe('fork()', () => {
  it("creates a run with parent_run_id and forked_from_checkpoint set, shares the source workspace_commit, emits agent.forked, and leaves the source run's checkpoint list and ledger head hash unchanged", async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'one\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const c1 = await fx.engine.checkpoint(run.run_id);
      await writeFiles(fx.repo.dir, { 'a.txt': 'two\n' });
      const c2 = await fx.engine.checkpoint(run.run_id);

      const sourceCheckpoints = await fx.backend.listCheckpoints(run.run_id);
      const sourceEvents = await allEvents(fx.backend, run.run_id);
      const sourceHead = sourceEvents.at(-1)?.hash;
      expect(sourceHead).toMatch(/^[0-9a-f]{64}$/);

      const forked = await fx.engine.fork(refOf(c1));
      expect(forked).toMatchObject({ parent_run_id: run.run_id, forked_from_checkpoint: 'c_1', agent: 'claude-code' });
      expect(forked.run_id).not.toBe(run.run_id);

      // The fork's workspace is the source workspace_commit itself.
      const worktree = fx.engine.worktreePath(forked.run_id);
      expect(await fx.engine.workspaceDir(forked.run_id)).toBe(worktree);
      expect((await git(worktree, ['rev-parse', 'HEAD'])).trim()).toBe(c1.workspace_commit);
      expect(await git(worktree, ['status', '--porcelain'])).toBe('');
      expect(await readFile(path.join(worktree, 'a.txt'), 'utf8')).toBe('one\n');

      const forkEvents = await allEvents(fx.backend, forked.run_id);
      expect(forkEvents.map((event) => event.type)).toEqual(['agent.forked']);
      expect(forkEvents[0]?.payload).toEqual({
        parent_run_id: run.run_id,
        forked_from_checkpoint: 'c_1',
        ledger_seq: c1.ledger_seq,
        workspace_commit: c1.workspace_commit,
      });

      // The fork's first checkpoint builds on the shared commit: same tree, git parent = source commit.
      const f1 = await fx.engine.checkpoint(forked.run_id);
      expect(f1).toMatchObject({ run_id: forked.run_id, checkpoint_id: 'c_1', parent_checkpoint_id: null });
      expect((await git(fx.repo.dir, ['rev-parse', `${f1.workspace_commit}^`])).trim()).toBe(c1.workspace_commit);
      expect(await treeOf(fx.repo.dir, f1.workspace_commit)).toBe(await treeOf(fx.repo.dir, c1.workspace_commit));

      // The fork diverges on its own lineage.
      await writeFiles(worktree, { 'b.txt': 'fork only\n' });
      const f2 = await fx.engine.checkpoint(forked.run_id);
      expect(f2.parent_checkpoint_id).toBe('c_1');
      expect(await treePaths(fx.repo.dir, f2.workspace_commit)).toEqual(['a.txt', 'b.txt']);

      // The source run is exactly as it was.
      expect(await fx.backend.listCheckpoints(run.run_id)).toEqual(sourceCheckpoints);
      const sourceAfter = await allEvents(fx.backend, run.run_id);
      expect(sourceAfter).toHaveLength(sourceEvents.length);
      expect(sourceAfter.at(-1)?.hash).toBe(sourceHead);
      expect((await git(fx.repo.dir, ['rev-parse', `refs/checkpoints/${run.run_id}/c_2`])).trim()).toBe(c2.workspace_commit);
      expect(await readFile(path.join(fx.repo.dir, 'a.txt'), 'utf8')).toBe('two\n');
    } finally {
      await fx.cleanup();
    }
  });
});
