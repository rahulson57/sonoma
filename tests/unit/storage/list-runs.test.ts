/** SPEC-015 amendment 5 / SPEC-005: listRuns() returns every run in the store, forks included, identically before and after reindex(). */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import type { Run } from '../../../src/model/types.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, openBackend } from '../../integration/storage/support.js';

describe('listRuns()', () => {
  it('returns every run including forks, before and after reindex', async () => {
    const repo = await tmpGitRepo({ files: { 'a.txt': 'a\n' } });
    try {
      const { backend, clock } = await openBackend(repo.dir);
      expect(await backend.listRuns()).toEqual([]);

      const first = await backend.createRun({ agent: 'claude-code' });
      clock.tick(1000);
      const second = await backend.createRun({ agent: 'sdk' });
      clock.tick(1000);
      const c1 = await checkpointFiles(backend, { run_id: first.run_id, parent_checkpoint_id: null }, { 'a.txt': 'one\n' });
      clock.tick(1000);
      const fork = await backend.fork({ run_id: first.run_id, checkpoint_id: c1.checkpoint_id });
      clock.tick(1000);
      const f1 = await checkpointFiles(backend, { run_id: fork.run_id, parent_checkpoint_id: null }, { 'a.txt': 'fork\n' });
      clock.tick(1000);
      const forkOfFork = await backend.fork({ run_id: fork.run_id, checkpoint_id: f1.checkpoint_id });

      expect(fork).toMatchObject({ parent_run_id: first.run_id, forked_from_checkpoint: 'c_1' });
      expect(forkOfFork).toMatchObject({ parent_run_id: fork.run_id, forked_from_checkpoint: 'c_1' });
      const expected: Run[] = [first, second, fork, forkOfFork];
      const before = await backend.listRuns();
      expect(before).toEqual(expected);

      // Reindexing a live index changes nothing.
      await backend.reindex();
      expect(await backend.listRuns()).toEqual(before);
      await backend.close();

      // A fresh backend reads the same list.
      const reopened = await openBackend(repo.dir);
      expect(await reopened.backend.listRuns()).toEqual(before);
      await reopened.backend.close();

      // Lose the index entirely, and leave an abandoned createRun (a run directory without run.json); then rebuild.
      const store = path.join(repo.dir, '.ckpt');
      for (const file of ['checkpoint.db', 'checkpoint.db-wal', 'checkpoint.db-shm']) await rm(path.join(store, file), { force: true });
      await mkdir(path.join(store, 'runs', 'run_01J8Z3K5QW7XV2M9N4P6R8T0ZZ'), { mode: 0o700 });
      const rebuilt = await openBackend(repo.dir);
      try {
        expect(await rebuilt.backend.listRuns()).toEqual([]);
        await rebuilt.backend.reindex();
        expect(await rebuilt.backend.listRuns()).toEqual(before);
      } finally {
        await rebuilt.backend.close();
      }
    } finally {
      await repo.cleanup();
    }
  });
});
