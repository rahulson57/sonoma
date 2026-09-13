/**
 * DEC-019(1): with a parent tree and a `changes` delta, createCheckpoint builds on the parent commit's
 * tree and reads only the written files from stagingDir. A delta that does not fit fails with
 * ERR_INVALID_CHANGES and writes nothing.
 */
import { createHash } from 'node:crypto';
import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import type { Checkpoint } from '../../../src/model/types.js';
import { GitRepo, type LocalBackend, type WorkspaceChanges } from '../../../src/storage/index.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { NO_USAGE, START_MS, git, makeTempDir, openBackend, treeFiles, walkTree, writeFiles } from './support.js';

const BASE: Record<string, string> = {
  'README.md': '# fixture\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 1;\n',
  'src/deep/c.ts': 'export const c = 1;\n',
  'gone/only.txt': 'soon deleted\n',
  'keep/k1.txt': 'k1\n',
  'keep/k2.txt': 'k2\n',
};

function checkpoint(
  backend: LocalBackend,
  stagingDir: string,
  input: { run_id: string; parent_checkpoint_id: string | null; changes?: WorkspaceChanges },
): Promise<Checkpoint> {
  return backend.createCheckpoint({ pending_intent: [], usage: NO_USAGE, ...input, stagingDir });
}

async function treeOf(repoDir: string, commit: string): Promise<string> {
  return (await git(repoDir, ['rev-parse', `${commit}^{tree}`])).trim();
}

async function parentOf(repoDir: string, commit: string): Promise<string> {
  return (await git(repoDir, ['rev-parse', `${commit}^`])).trim();
}

/** Everything a rejected createCheckpoint must leave untouched: index rows, events, refs, git objects and CAS. */
async function noWriteSnapshot(backend: LocalBackend, repoDir: string, runId: string) {
  return {
    checkpoints: await backend.listCheckpoints(runId),
    events: await backend.getEvents(runId, { fromSeq: 1, toSeq: 1000 }),
    refs: await git(repoDir, ['for-each-ref', 'refs/checkpoints/']),
    gitObjects: await git(repoDir, ['count-objects', '-v']),
    store: (await walkTree(path.join(repoDir, '.ckpt', 'objects'))).map((entry) => entry.rel).sort(),
  };
}

/** The git blob id of `content`, without writing it. */
function blobId(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** The tree of a full build of `stagingDir` (no parent, no delta, no ref). */
async function fullBuildTree(repoDir: string, stagingDir: string): Promise<string> {
  const scratch = await makeTempDir('ckpt-full-');
  try {
    const repo = await GitRepo.open(repoDir);
    return (await repo.commitTree(stagingDir, { parent: null, message: 'full build', timeMs: START_MS, tmpDir: scratch.dir })).tree;
  } finally {
    await scratch.cleanup();
  }
}

describe('incremental createCheckpoint', () => {
  it('builds the same tree as a full build of the final contents: edits, additions, deletes, mode and symlink changes', async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-incr-');
    const { backend, clock } = await openBackend(repo.dir);
    try {
      await writeFiles(staging.dir, { ...BASE, 'bin/run.sh': '#!/bin/sh\n' });
      await chmod(path.join(staging.dir, 'bin/run.sh'), 0o755);
      await symlink('src/a.ts', path.join(staging.dir, 'link'));
      const run = await backend.createRun({ agent: 'claude-code' });
      const first = await checkpoint(backend, staging.dir, { run_id: run.run_id, parent_checkpoint_id: null });

      await writeFile(path.join(staging.dir, 'src/a.ts'), 'export const a = 2;\n');
      await writeFiles(staging.dir, { 'new/dir/n.ts': 'export const n = 1;\n' });
      await rm(path.join(staging.dir, 'gone'), { recursive: true });
      await rm(path.join(staging.dir, 'src/b.ts'));
      await chmod(path.join(staging.dir, 'bin/run.sh'), 0o644);
      await rm(path.join(staging.dir, 'link'));
      await symlink('README.md', path.join(staging.dir, 'link'));
      clock.tick(1000);
      const second = await checkpoint(backend, staging.dir, {
        run_id: run.run_id,
        parent_checkpoint_id: first.checkpoint_id,
        changes: { written: ['src/a.ts', 'new/dir/n.ts', 'bin/run.sh', 'link'], deleted: ['gone/only.txt', 'src/b.ts'] },
      });

      expect(await treeOf(repo.dir, second.workspace_commit)).toBe(await fullBuildTree(repo.dir, staging.dir));
      expect(await parentOf(repo.dir, second.workspace_commit)).toBe(first.workspace_commit);
      const files = await treeFiles(repo.dir, second.workspace_commit);
      expect([...files.keys()]).toEqual(['README.md', 'bin/run.sh', 'keep/k1.txt', 'keep/k2.txt', 'link', 'new/dir/n.ts', 'src/a.ts', 'src/deep/c.ts']);
      expect(files.get('bin/run.sh')?.mode).toBe('100644');
      expect(files.get('link')?.mode).toBe('120000');
      expect(await git(repo.dir, ['cat-file', 'blob', `${second.workspace_commit}:link`])).toBe('README.md');
      expect(await git(repo.dir, ['cat-file', 'blob', `${second.workspace_commit}:src/a.ts`])).toBe('export const a = 2;\n');
      expect(await git(repo.dir, ['ls-tree', second.workspace_commit, 'gone'])).toBe('');

      // The same final contents checkpointed without a delta give the same tree.
      clock.tick(1000);
      const third = await checkpoint(backend, staging.dir, { run_id: run.run_id, parent_checkpoint_id: second.checkpoint_id });
      expect(await treeOf(repo.dir, third.workspace_commit)).toBe(await treeOf(repo.dir, second.workspace_commit));
      expect((await backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual(['c_1', 'c_2', 'c_3']);
    } finally {
      await backend.close();
      await staging.cleanup();
      await repo.cleanup();
    }
  });

  it('reads only the written files: unchanged files are never opened', async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-incr-');
    const scratch = await makeTempDir('ckpt-incr-tmp-');
    const unreadable = path.join(staging.dir, 'pkg3/f3.txt');
    try {
      const gitRepo = await GitRepo.open(repo.dir);
      const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`pkg${i % 10}/f${i}.txt`, `file ${i}\n`]));
      await writeFiles(staging.dir, files);
      const base = await gitRepo.commitTree(staging.dir, { parent: null, message: 'base', timeMs: START_MS, tmpDir: scratch.dir });
      expect(base.hashed).toBe(200);

      await writeFile(path.join(staging.dir, 'pkg0/f0.txt'), 'changed\n');
      await rm(path.join(staging.dir, 'pkg1/f1.txt'));
      // Not in the delta, so never read: different bytes on disk must not reach the commit...
      await writeFile(path.join(staging.dir, 'pkg2/f2.txt'), 'NOT READ\n');
      // ...and an unreadable file must not fail it (root ignores permissions, so this half needs a non-root user).
      if (process.getuid?.() !== 0) await chmod(unreadable, 0o000);

      const next = await gitRepo.commitTree(staging.dir, {
        parent: base.commit,
        changes: { written: ['pkg0/f0.txt'], deleted: ['pkg1/f1.txt'] },
        message: 'next',
        timeMs: START_MS + 1000,
        tmpDir: scratch.dir,
      });
      expect(next.hashed).toBe(1);

      const before = await treeFiles(repo.dir, base.commit);
      const after = await treeFiles(repo.dir, next.commit);
      expect(after.size).toBe(199);
      expect(after.has('pkg1/f1.txt')).toBe(false);
      expect(after.get('pkg2/f2.txt')).toEqual(before.get('pkg2/f2.txt'));
      expect(after.get('pkg3/f3.txt')).toEqual(before.get('pkg3/f3.txt'));
      expect(await git(repo.dir, ['cat-file', 'blob', `${next.commit}:pkg0/f0.txt`])).toBe('changed\n');
      expect(await parentOf(repo.dir, next.commit)).toBe(base.commit);
    } finally {
      await chmod(unreadable, 0o644).catch(() => undefined);
      await scratch.cleanup();
      await staging.cleanup();
      await repo.cleanup();
    }
  });

  it('rejects a delta that does not fit with ERR_INVALID_CHANGES and writes nothing', async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-incr-');
    const { backend, clock } = await openBackend(repo.dir);
    try {
      await writeFiles(staging.dir, BASE);
      const run = await backend.createRun({ agent: 'claude-code' });
      const first = await checkpoint(backend, staging.dir, { run_id: run.run_id, parent_checkpoint_id: null });

      const snapshot = () => noWriteSnapshot(backend, repo.dir, run.run_id);
      const before = await snapshot();

      await writeFile(path.join(staging.dir, 'src/a.ts'), 'export const a = 2;\n');
      await rm(path.join(staging.dir, 'src/b.ts'));
      clock.tick(1000);
      const bad: Array<[string, WorkspaceChanges]> = [
        ['a written path missing from stagingDir', { written: ['src/a.ts', 'src/missing.ts'], deleted: ['src/b.ts'] }],
        ['a deleted path absent from the parent tree', { written: ['src/a.ts'], deleted: ['src/b.ts', 'src/never.ts'] }],
        ['a deleted directory rather than a file', { written: ['src/a.ts'], deleted: ['src/deep'] }],
        ['a path both written and deleted', { written: ['src/a.ts'], deleted: ['src/a.ts'] }],
        ['a written directory', { written: ['src/deep'], deleted: [] }],
        ['an absolute path', { written: ['/etc/hosts'], deleted: [] }],
        ['a path escaping the root', { written: ['../outside.txt'], deleted: [] }],
        ['a non-canonical path', { written: ['src//a.ts'], deleted: [] }],
        ['a .git path', { written: ['.git/config'], deleted: [] }],
        ['a case variant of .git', { written: ['src/a.ts', '.GIT/config'], deleted: [] }],
        ['a malformed delta', { written: 'src/a.ts', deleted: [] } as unknown as WorkspaceChanges],
      ];
      for (const [name, changes] of bad) {
        await expect(
          checkpoint(backend, staging.dir, { run_id: run.run_id, parent_checkpoint_id: first.checkpoint_id, changes }),
          name,
        ).rejects.toMatchObject({ code: 'ERR_INVALID_CHANGES' });
        expect(await snapshot(), name).toEqual(before);
      }

      const second = await checkpoint(backend, staging.dir, {
        run_id: run.run_id,
        parent_checkpoint_id: first.checkpoint_id,
        changes: { written: ['src/a.ts'], deleted: ['src/b.ts'] },
      });
      expect(second.checkpoint_id).toBe('c_2');
      expect(second.ledger_seq).toBe(first.ledger_seq + 1);
      expect(await treeOf(repo.dir, second.workspace_commit)).toBe(await fullBuildTree(repo.dir, staging.dir));
    } finally {
      await backend.close();
      await staging.cleanup();
      await repo.cleanup();
    }
  });

  it('rejects a file/directory clash the delta does not resolve, and accepts it once the displaced entries are deleted', async () => {
    const repo = await tmpGitRepo();
    const parentStaging = await makeTempDir('ckpt-incr-');
    const staging = await makeTempDir('ckpt-incr-');
    const scratch = await makeTempDir('ckpt-incr-tmp-');
    try {
      const gitRepo = await GitRepo.open(repo.dir);
      await writeFiles(parentStaging.dir, { 'a/x.txt': 'x\n', b: 'b\n', 'c.txt': 'c\n' });
      const base = await gitRepo.commitTree(parentStaging.dir, { parent: null, message: 'base', timeMs: START_MS, tmpDir: scratch.dir });
      // `a` becomes a file where a directory was; `b` becomes a directory where a file was.
      await writeFiles(staging.dir, { a: 'a is a file now\n', 'b/y.txt': 'y\n', 'c.txt': 'c\n' });
      const commit = (changes: WorkspaceChanges) =>
        gitRepo.commitTree(staging.dir, { parent: base.commit, changes, message: 'next', timeMs: START_MS + 1000, tmpDir: scratch.dir });

      await expect(commit({ written: ['a', 'b/y.txt'], deleted: ['b'] })).rejects.toMatchObject({ code: 'ERR_INVALID_CHANGES' });
      await expect(commit({ written: ['a', 'b/y.txt'], deleted: ['a/x.txt'] })).rejects.toMatchObject({ code: 'ERR_INVALID_CHANGES' });
      const next = await commit({ written: ['a', 'b/y.txt'], deleted: ['a/x.txt', 'b'] });
      expect(next.tree).toBe(await fullBuildTree(repo.dir, staging.dir));
    } finally {
      await scratch.cleanup();
      await staging.cleanup();
      await parentStaging.cleanup();
      await repo.cleanup();
    }
  });

  it('rejects a written path that goes through a symlinked directory, so bytes from outside stagingDir never reach a commit', async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-incr-');
    const outside = await makeTempDir('ckpt-outside-');
    const { backend, clock } = await openBackend(repo.dir);
    const SECRET = 'OUTSIDE-STAGING-UNSANITIZED\n';
    const DEEP_SECRET = 'OUTSIDE-STAGING-DEEPER\n';
    const expectRejected = async (runId: string, parentId: string, changes: WorkspaceChanges) => {
      const before = await noWriteSnapshot(backend, repo.dir, runId);
      await expect(
        checkpoint(backend, staging.dir, { run_id: runId, parent_checkpoint_id: parentId, changes }),
        JSON.stringify(changes),
      ).rejects.toMatchObject({ code: 'ERR_INVALID_CHANGES' });
      expect(await noWriteSnapshot(backend, repo.dir, runId), JSON.stringify(changes)).toEqual(before);
    };
    try {
      await writeFiles(outside.dir, { 'secret.txt': SECRET, 'deeper/s2.txt': DEEP_SECRET });
      await writeFiles(staging.dir, { 'f.txt': 'f\n', 'real/r.txt': 'r\n' });
      const run = await backend.createRun({ agent: 'claude-code' });
      const first = await checkpoint(backend, staging.dir, { run_id: run.run_id, parent_checkpoint_id: null });

      // Repro 1: the parent has no `lnk`; stagingDir/lnk (and real/lnk) point outside stagingDir.
      await symlink(outside.dir, path.join(staging.dir, 'lnk'));
      await symlink(outside.dir, path.join(staging.dir, 'real', 'lnk'));
      clock.tick(1000);
      await expectRejected(run.run_id, first.checkpoint_id, { written: ['lnk/secret.txt'], deleted: [] });
      await expectRejected(run.run_id, first.checkpoint_id, { written: ['f.txt', 'real/lnk/deeper/s2.txt'], deleted: [] });

      // The links themselves are fine to commit: as 120000 entries holding their target, like a full build.
      const second = await checkpoint(backend, staging.dir, {
        run_id: run.run_id,
        parent_checkpoint_id: first.checkpoint_id,
        changes: { written: ['lnk', 'real/lnk'], deleted: [] },
      });
      expect(await treeOf(repo.dir, second.workspace_commit)).toBe(await fullBuildTree(repo.dir, staging.dir));
      expect((await treeFiles(repo.dir, second.workspace_commit)).get('lnk')?.mode).toBe('120000');

      // Repro 2: the parent already holds `lnk` as a symlink, the delta deletes it and writes through it,
      // and `lnk` is still a symlink on disk.
      clock.tick(1000);
      await expectRejected(run.run_id, second.checkpoint_id, { written: ['lnk/secret.txt'], deleted: ['lnk'] });
      await expectRejected(run.run_id, second.checkpoint_id, { written: ['real/lnk/secret.txt'], deleted: ['real/lnk'] });

      // Neither outside file ever became a git object.
      for (const content of [SECRET, DEEP_SECRET]) {
        await expect(git(repo.dir, ['cat-file', '-e', blobId(content)])).rejects.toThrow();
      }
      expect((await backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual(['c_1', 'c_2']);
    } finally {
      await backend.close();
      await outside.cleanup();
      await staging.cleanup();
      await repo.cleanup();
    }
  });

  it("a fork's first checkpoint builds on the source checkpoint's tree", async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-incr-');
    const { backend, clock } = await openBackend(repo.dir);
    try {
      await writeFiles(staging.dir, BASE);
      const source = await backend.createRun({ agent: 'claude-code' });
      const sourceCheckpoint = await checkpoint(backend, staging.dir, { run_id: source.run_id, parent_checkpoint_id: null });
      const forked = await backend.fork({ run_id: source.run_id, checkpoint_id: sourceCheckpoint.checkpoint_id });

      await writeFile(path.join(staging.dir, 'src/a.ts'), 'export const a = "fork";\n');
      await rm(path.join(staging.dir, 'keep/k2.txt'));
      clock.tick(1000);
      const first = await checkpoint(backend, staging.dir, {
        run_id: forked.run_id,
        parent_checkpoint_id: null,
        changes: { written: ['src/a.ts'], deleted: ['keep/k2.txt'] },
      });

      expect(first.checkpoint_id).toBe('c_1');
      expect(await parentOf(repo.dir, first.workspace_commit)).toBe(sourceCheckpoint.workspace_commit);
      expect(await treeOf(repo.dir, first.workspace_commit)).toBe(await fullBuildTree(repo.dir, staging.dir));
      // The next checkpoint builds on c_1's tree, where keep/k2.txt is already gone, so deleting it again is rejected.
      await expect(
        checkpoint(backend, staging.dir, { run_id: forked.run_id, parent_checkpoint_id: first.checkpoint_id, changes: { written: [], deleted: ['keep/k2.txt'] } }),
      ).rejects.toMatchObject({ code: 'ERR_INVALID_CHANGES' });
    } finally {
      await backend.close();
      await staging.cleanup();
      await repo.cleanup();
    }
  });

  it('without a parent tree the delta is ignored and stagingDir is committed in full', async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-incr-');
    const { backend } = await openBackend(repo.dir);
    try {
      await writeFiles(staging.dir, BASE);
      const run = await backend.createRun({ agent: 'claude-code' });
      const first = await checkpoint(backend, staging.dir, {
        run_id: run.run_id,
        parent_checkpoint_id: null,
        changes: { written: ['README.md'], deleted: [] },
      });
      expect(await treeOf(repo.dir, first.workspace_commit)).toBe(await fullBuildTree(repo.dir, staging.dir));
      expect([...(await treeFiles(repo.dir, first.workspace_commit)).keys()].sort()).toEqual(Object.keys(BASE).sort());
    } finally {
      await backend.close();
      await staging.cleanup();
      await repo.cleanup();
    }
  });
});
