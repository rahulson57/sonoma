/**
 * SPEC-005 "must never write to refs/heads/*, the user's .git/index, or the user's worktree":
 * checkpoint commits are built through a temporary index and land only under refs/checkpoints/<run>/.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, git, openBackend, sha256 } from './support.js';

describe('checkpoint refs isolation', () => {
  it('after 20 createCheckpoint calls refs/heads and the .git/index SHA are byte-identical and 20 refs exist under refs/checkpoints/<run>/', async () => {
    const repo = await tmpGitRepo({ files: { 'README.md': '# fixture\n', 'src/app.ts': 'export const version = 0;\n' } });
    const { backend, clock } = await openBackend(repo.dir);
    try {
      const headsBefore = await git(repo.dir, ['for-each-ref', 'refs/heads']);
      const indexBefore = sha256(await readFile(path.join(repo.dir, '.git', 'index')));
      const trackedBefore = await git(repo.dir, ['status', '--porcelain', '--untracked-files=no']);
      const headBefore = await git(repo.dir, ['rev-parse', 'HEAD']);

      const run = await backend.createRun({ agent: 'claude-code' });
      const created = [];
      let parent: string | null = null;
      for (let i = 1; i <= 20; i += 1) {
        const checkpoint = await checkpointFiles(
          backend,
          { run_id: run.run_id, parent_checkpoint_id: parent, label: i === 20 ? 'final' : null },
          { 'README.md': '# fixture\n', 'src/app.ts': `export const version = ${i};\n`, [`notes/step-${i}.md`]: `step ${i}\n` },
        );
        created.push(checkpoint);
        parent = checkpoint.checkpoint_id;
        clock.tick(1000);
      }

      expect(await git(repo.dir, ['for-each-ref', 'refs/heads'])).toBe(headsBefore);
      expect(sha256(await readFile(path.join(repo.dir, '.git', 'index')))).toBe(indexBefore);
      expect(await git(repo.dir, ['status', '--porcelain', '--untracked-files=no'])).toBe(trackedBefore);
      expect(await git(repo.dir, ['rev-parse', 'HEAD'])).toBe(headBefore);

      const refs = (await git(repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/checkpoints/${run.run_id}/`]))
        .trim()
        .split('\n');
      expect(refs).toHaveLength(20);
      expect(new Set(refs)).toEqual(new Set(created.map((cp) => `refs/checkpoints/${run.run_id}/${cp.checkpoint_id} ${cp.workspace_commit}`)));
      expect(created.map((cp) => cp.checkpoint_id)).toEqual(Array.from({ length: 20 }, (_, i) => `c_${i + 1}`));

      // Each commit holds exactly its staging tree and chains to its parent checkpoint.
      const last = created[19]!;
      expect(await git(repo.dir, ['show', `${last.workspace_commit}:src/app.ts`])).toBe('export const version = 20;\n');
      expect((await git(repo.dir, ['ls-tree', '-r', '--name-only', last.workspace_commit])).trim().split('\n')).toEqual([
        'README.md',
        'notes/step-20.md',
        'src/app.ts',
      ]);
      expect((await git(repo.dir, ['rev-list', '--count', last.workspace_commit])).trim()).toBe('20');

      expect(await backend.listCheckpoints(run.run_id)).toEqual(created);
      const state = await backend.getState({ run_id: run.run_id, checkpoint_id: 'c_20' });
      expect(state).toMatchObject({ run_id: run.run_id, checkpoint_id: 'c_20', workspace_commit: last.workspace_commit, ledger_seq: last.ledger_seq });
      expect(sha256(await readFile(path.join(repo.dir, '.ckpt', 'objects', 'sha256', last.state_hash.slice(0, 2), last.state_hash)))).toBe(
        last.state_hash,
      );
    } finally {
      await backend.close();
      await repo.cleanup();
    }
    // 20 checkpoints spawn ~120 git processes; the default 5 s is too tight when suites run in parallel.
  }, 60_000);
});
