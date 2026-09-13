import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

const execFileAsync = promisify(execFile);

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('tmpGitRepo', () => {
  const created: TmpGitRepo[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((r) => r.cleanup()));
  });

  it('creates a git repository under os.tmpdir() and cleanup() removes it', async () => {
    const repo = await tmpGitRepo();
    created.push(repo);
    const tmpBase = await realpath(os.tmpdir());

    expect(path.isAbsolute(repo.dir)).toBe(true);
    expect(repo.dir.startsWith(tmpBase + path.sep)).toBe(true);
    expect(await exists(path.join(repo.dir, '.git'))).toBe(true);
    expect(await gitOut(repo.dir, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    expect(await realpath(await gitOut(repo.dir, ['rev-parse', '--show-toplevel']))).toBe(repo.dir);

    await repo.cleanup();
    expect(await exists(repo.dir)).toBe(false);
  });

  it('cleanup() is idempotent', async () => {
    const repo = await tmpGitRepo();
    await repo.cleanup();
    await expect(repo.cleanup()).resolves.toBeUndefined();
    expect(await exists(repo.dir)).toBe(false);
  });

  it('commits the given files on main with a clean working tree', async () => {
    const files = { 'README.md': '# fixture\n', 'src/nested/index.ts': 'export const x = 1;\n' };
    const repo = await tmpGitRepo({ files });
    created.push(repo);

    expect(await gitOut(repo.dir, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect((await gitOut(repo.dir, ['ls-files'])).split('\n').sort()).toEqual(Object.keys(files).sort());
    expect(await gitOut(repo.dir, ['status', '--porcelain'])).toBe('');
    for (const [rel, content] of Object.entries(files)) {
      expect(await readFile(path.join(repo.dir, rel), 'utf8')).toBe(content);
    }
  });

  it('creates a HEAD commit even with no files, with a reproducible SHA', async () => {
    const a = await tmpGitRepo({ files: { 'a.txt': 'same\n' } });
    const b = await tmpGitRepo({ files: { 'a.txt': 'same\n' } });
    created.push(a, b);

    expect(a.dir).not.toBe(b.dir);
    const shaA = await gitOut(a.dir, ['rev-parse', 'HEAD']);
    expect(shaA).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitOut(b.dir, ['rev-parse', 'HEAD'])).toBe(shaA);

    const empty = await tmpGitRepo();
    created.push(empty);
    expect(await gitOut(empty.dir, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('refuses file paths that escape the repository', async () => {
    await expect(tmpGitRepo({ files: { '../escape.txt': 'x' } })).rejects.toThrow(/escapes/);
    await expect(tmpGitRepo({ files: { [path.join(os.tmpdir(), 'abs.txt')]: 'x' } })).rejects.toThrow(/relative/);
    await expect(tmpGitRepo({ files: { '.git/config': 'x' } })).rejects.toThrow(/\.git/);
  });

  it('ignores GIT_DIR / GIT_WORK_TREE inherited from the environment', async () => {
    const decoy = await tmpGitRepo();
    created.push(decoy);
    const decoyHead = await gitOut(decoy.dir, ['rev-parse', 'HEAD']);
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(decoy.dir, '.git');
    process.env.GIT_WORK_TREE = decoy.dir;
    try {
      const repo = await tmpGitRepo({ files: { 'x.txt': 'x\n' } });
      created.push(repo);
      expect(await gitOut(repo.dir, ['ls-files'])).toBe('x.txt');
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
    expect(await gitOut(decoy.dir, ['rev-parse', 'HEAD'])).toBe(decoyHead);
    expect(await gitOut(decoy.dir, ['ls-files'])).toBe('');
  });
});
