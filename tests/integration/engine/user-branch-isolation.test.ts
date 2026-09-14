/**
 * SPEC-006 "must never move refs/heads/* or write the user's worktree/index": checkpoint, resume, fork and
 * rollback touch neither the user's branches, nor .git/index, nor HEAD, nor files in the user's worktree.
 */
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { WorkspaceGit, isEngineError } from '../../../src/engine/index.js';
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

  it("a user linked worktree whose directory is missing keeps its registration and index through resume, fork and rollback", async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ckpt-userwt-'));
    try {
      const repo = fx.repo.dir;
      const userWorktree = path.join(outside, 'feature-wt');
      const movedAway = path.join(outside, 'feature-wt.away');
      await git(repo, ['worktree', 'add', '--quiet', '-b', 'feature', userWorktree]);
      await writeFiles(userWorktree, { 'staged.txt': 'staged work\n' });
      await git(userWorktree, ['add', 'staged.txt']);

      const commonDir = path.resolve(repo, (await git(repo, ['rev-parse', '--git-common-dir'])).trim());
      const admin = path.join(commonDir, 'worktrees', 'feature-wt');
      const adminState = async () => ({
        gitdir: await readFile(path.join(admin, 'gitdir'), 'utf8'),
        head: await readFile(path.join(admin, 'HEAD'), 'utf8'),
        index: sha256(await readFile(path.join(admin, 'index'))),
      });
      const before = await adminState();
      // Like an unmounted drive: git now considers this registration prunable.
      await rename(userWorktree, movedAway);

      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const c1 = await fx.engine.checkpoint(run.run_id);
      await writeFiles(repo, { 'notes.md': 'agent work\n' });
      const c2 = await fx.engine.checkpoint(run.run_id);
      expect(await adminState()).toEqual(before);

      await fx.engine.resume(refOf(c1));
      expect(await adminState()).toEqual(before);
      const forked = await fx.engine.fork(refOf(c2));
      expect(await adminState()).toEqual(before);
      await fx.engine.rollback(refOf(c1));
      expect(await adminState()).toEqual(before);

      // Re-creating ckpt's OWN execution worktree after its directory vanished takes over only that stale registration.
      await rm(fx.engine.worktreePath(run.run_id), { recursive: true, force: true });
      const restored = await fx.engine.resume(refOf(c2));
      expect(await adminState()).toEqual(before);
      expect(await git(restored.worktreePath, ['status', '--porcelain'])).toBe('');
      expect((await git(restored.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(c2.workspace_commit);
      await fx.engine.checkpoint(forked.run_id);
      expect(await adminState()).toEqual(before);

      // Once the directory is back, the user's worktree and its staged work are intact.
      await rename(movedAway, userWorktree);
      expect(await git(userWorktree, ['status', '--porcelain'])).toBe('A  staged.txt\n');
      expect((await git(userWorktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('feature');
    } finally {
      await rm(outside, { recursive: true, force: true });
      await fx.cleanup();
    }
  });

  it("refuses to force-checkout or clean an existing directory that belongs to another repository", async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ckpt-foreign-'));
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const c1 = await fx.engine.checkpoint(run.run_id);
      // A clone sharing the object store resolves the checkpoint commit, so only the common-dir check stops a checkout.
      const clone = path.join(outside, 'clone');
      await git(fx.repo.dir, ['clone', '--quiet', '--shared', fx.repo.dir, clone]);
      await git(clone, ['cat-file', '-e', `${c1.workspace_commit}^{commit}`]);
      await writeFiles(clone, { 'unsaved.txt': 'the user\'s unsaved work\n' });

      const workspaceGit = await WorkspaceGit.open(fx.repo.dir);
      await expect(workspaceGit.materialize(clone, c1.workspace_commit)).rejects.toSatisfy((err: unknown) => isEngineError(err, 'ERR_WORKSPACE'));
      expect(await readFile(path.join(clone, 'unsaved.txt'), 'utf8')).toBe('the user\'s unsaved work\n');
      expect(await git(clone, ['status', '--porcelain'])).toBe('?? unsaved.txt\n');
    } finally {
      await rm(outside, { recursive: true, force: true });
      await fx.cleanup();
    }
  });
});
