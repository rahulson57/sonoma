/**
 * SPEC-006 "must never move refs/heads/* or write the user's worktree/index": checkpoint, resume, fork and
 * rollback touch neither the user's branches, nor .git/index, nor HEAD, nor files in the user's worktree.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { engineFixture, git, refOf, sha256, writeFiles } from './support.js';

describe('user branch isolation', () => {
  it('refs/heads/* and .git/index SHA are byte-identical before and after checkpoint, resume, fork and rollback', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n', 'src/app.ts': 'export const v = 0;\n' } });
    try {
      const repo = fx.repo.dir;
      await git(repo, ['branch', 'feature']);
      const userState = async () => ({
        heads: await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
        index: sha256(await readFile(path.join(repo, '.git', 'index'))),
        head: await readFile(path.join(repo, '.git', 'HEAD'), 'utf8'),
        readme: await readFile(path.join(repo, 'README.md'), 'utf8'),
        app: await readFile(path.join(repo, 'src', 'app.ts'), 'utf8'),
      });
      const before = await userState();
      expect(before.heads.trim().split('\n')).toHaveLength(2);

      const run = await fx.engine.startRun({ agent: 'claude-code' });
      await writeFiles(repo, { 'notes.md': 'agent work\n' });
      const c1 = await fx.engine.checkpoint(run.run_id);
      expect(await userState()).toEqual(before);

      await writeFiles(repo, { 'notes.md': 'more agent work\n' });
      const c2 = await fx.engine.checkpoint(run.run_id);
      expect(await userState()).toEqual(before);

      const restored = await fx.engine.resume(refOf(c1));
      expect(await userState()).toEqual(before);
      await writeFiles(restored.worktreePath, { 'src/app.ts': 'export const v = 1;\n' });
      const c3 = await fx.engine.checkpoint(run.run_id);
      expect(await userState()).toEqual(before);

      const forked = await fx.engine.fork(refOf(c2));
      expect(await userState()).toEqual(before);
      await fx.engine.checkpoint(forked.run_id);
      expect(await userState()).toEqual(before);

      await fx.engine.rollback(refOf(c1));
      expect(await userState()).toEqual(before);

      // Resume into the already existing execution worktree (forced checkout path).
      await fx.engine.resume(refOf(c3));
      expect(await userState()).toEqual(before);

      // The agent's own file in the user's worktree was never rewritten by the engine.
      expect(await readFile(path.join(repo, 'notes.md'), 'utf8')).toBe('more agent work\n');

      // Execution worktrees are detached: no branch exists for them.
      const worktrees = (await git(repo, ['worktree', 'list', '--porcelain'])).trim().split('\n\n');
      const execution = worktrees.filter((block) => block.includes(path.join('ckpt', 'worktrees')));
      expect(execution).toHaveLength(2);
      for (const block of execution) {
        expect(block).toContain('\ndetached');
        expect(block).not.toContain('\nbranch ');
      }
    } finally {
      await fx.cleanup();
    }
  });
});
