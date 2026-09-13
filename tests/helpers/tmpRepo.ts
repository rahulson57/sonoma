/**
 * Throwaway git repositories for tests (SPEC-001 "Git fixtures").
 *
 * Repos are created only under the OS temp dir, never touch a real user repo, and are isolated
 * from the invoking environment: inherited `GIT_*` variables (e.g. GIT_DIR / GIT_INDEX_FILE set
 * when tests run inside a git hook) are stripped so git can never be redirected at the enclosing
 * repository, and system config, hooks and commit signing are disabled. Author/committer
 * identity and dates are fixed, so fixture commit SHAs are reproducible.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const TMP_REPO_PREFIX = 'ckpt-tmprepo-';
export const FIXTURE_IDENTITY = { name: 'ckpt fixture', email: 'fixture@ckpt.invalid' } as const;
/** 2000-01-01T00:00:00Z in git's internal date format. */
const FIXTURE_DATE = '946684800 +0000';

export interface TmpGitRepo {
  /** Absolute, symlink-resolved path of the repository's working tree. */
  dir: string;
  /** Removes the repository. Idempotent. */
  cleanup(): Promise<void>;
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
    GIT_AUTHOR_DATE: FIXTURE_DATE,
    GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    GIT_COMMITTER_DATE: FIXTURE_DATE,
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: isolatedGitEnv() });
}

/** Resolve a fixture file path inside `root`, rejecting anything that would escape it. */
function resolveInside(root: string, relPath: string): string {
  if (relPath === '' || path.isAbsolute(relPath)) {
    throw new Error(`tmpGitRepo: file path must be relative and non-empty, got ${JSON.stringify(relPath)}`);
  }
  const target = path.resolve(root, relPath);
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep)[0] === '.git') {
    throw new Error(`tmpGitRepo: file path escapes the repository or targets .git: ${JSON.stringify(relPath)}`);
  }
  return target;
}

async function removeTmpDir(base: string, dir: string): Promise<void> {
  // Guard: only ever delete a directory this helper created directly under the OS temp dir.
  if (path.dirname(dir) !== base || !path.basename(dir).startsWith(TMP_REPO_PREFIX)) {
    throw new Error(`tmpGitRepo: refusing to remove ${dir}: not a tmpGitRepo directory`);
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * Create a git repository in a fresh directory under `os.tmpdir()`, on branch `main`, with one
 * initial commit containing `opts.files` (path → UTF-8 content; empty commit if none).
 */
export async function tmpGitRepo(opts?: { files?: Record<string, string> }): Promise<TmpGitRepo> {
  const base = await realpath(os.tmpdir());
  const dir = await mkdtemp(path.join(base, TMP_REPO_PREFIX));
  try {
    const files = Object.entries(opts?.files ?? {}).map(([rel, content]) => [resolveInside(dir, rel), content] as const);

    // --template= : no template hooks copied in. symbolic-ref instead of `init -b` (git < 2.28).
    await git(dir, ['init', '--quiet', '--template=']);
    await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const localConfig: Array<[string, string]> = [
      ['user.name', FIXTURE_IDENTITY.name],
      ['user.email', FIXTURE_IDENTITY.email],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.hooksPath', path.join(dir, '.git', 'hooks')],
      ['core.autocrlf', 'false'],
    ];
    for (const [key, value] of localConfig) await git(dir, ['config', key, value]);

    for (const [target, content] of files) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    await git(dir, ['add', '--all']);
    await git(dir, ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'fixture: initial commit']);
  } catch (err) {
    await removeTmpDir(base, dir);
    throw err;
  }

  return {
    dir,
    cleanup: () => removeTmpDir(base, dir),
  };
}
