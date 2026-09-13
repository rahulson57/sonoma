/**
 * Git operations the engine needs beyond Local Storage's commit plumbing: reading checkpoint trees,
 * diffing two checkpoint commits, and materialising a checkpoint into a run's EXECUTION WORKTREE.
 *
 * The engine never moves `refs/heads/*` and never writes the user's worktree or index (SPEC-006):
 * - tree reads and diffs are commit-to-commit and touch no index;
 * - a workspace is only ever written inside an execution worktree, a detached `git worktree` with its own
 *   index under `<git common dir>/worktrees/<name>`. Before a forced checkout the directory is verified
 *   to be the top level of its own worktree, so a misconfigured path can never force-checkout the
 *   user's worktree.
 *
 * Every invocation strips inherited GIT_* variables, disables hooks, system config and optional locks,
 * and never talks to a remote.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from '../storage/fs-util.js';
import { EngineError } from './errors.js';
import type { ObjectFormat, TreeEntry, TreeMode } from './snapshot.js';
import type { NameStatus } from './types.js';

const CONFIG_OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0'];

/**
 * Untracked paths a restore keeps in an execution worktree: the SPEC-003 hard-excluded secret paths.
 * Checkpoints never contain them, so the user supplies them again after a restore and a later restore
 * must not delete them.
 */
export const PRESERVED_ON_RESTORE = ['.env*', 'credentials*', '*.pem', '*.key'] as const;

interface GitOutput {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

function runGit(args: readonly string[], cwd: string): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...CONFIG_OVERRIDES, ...args], { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => reject(new EngineError('ERR_GIT', `could not run git: ${err.message}`, { cause: err })));
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function gitOk(args: readonly string[], cwd: string): Promise<Buffer> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new EngineError('ERR_GIT', `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const TREE_MODES: ReadonlySet<string> = new Set<TreeMode>(['100644', '100755', '120000']);

export class WorkspaceGit {
  /** Top level of the user's worktree (read-only for the engine). */
  readonly workTree: string;
  /** The repository's common git directory (shared by all worktrees). */
  readonly commonDir: string;
  readonly objectFormat: ObjectFormat;

  private constructor(workTree: string, commonDir: string, objectFormat: ObjectFormat) {
    this.workTree = workTree;
    this.commonDir = commonDir;
    this.objectFormat = objectFormat;
  }

  static async open(repoDir: string): Promise<WorkspaceGit> {
    const result = await runGit(['rev-parse', '--show-toplevel', '--git-common-dir'], repoDir);
    const [workTree, commonDir] = result.stdout.toString('utf8').split('\n');
    if (result.code !== 0 || !workTree || !commonDir) {
      throw new EngineError('ERR_GIT', `${repoDir} is not inside a git worktree: ${result.stderr.trim()}`);
    }
    // `extensions.objectFormat` is unset (exit 1) in sha1 repositories.
    const format = await runGit(['config', '--get', 'extensions.objectformat'], workTree);
    const objectFormat: ObjectFormat = format.code === 0 && format.stdout.toString('utf8').trim() === 'sha256' ? 'sha256' : 'sha1';
    return new WorkspaceGit(workTree, path.resolve(repoDir, commonDir), objectFormat);
  }

  /** Every blob of `commit`'s tree: path → {mode, oid}. */
  async readTree(commit: string): Promise<Map<string, TreeEntry>> {
    const out = (await gitOk(['ls-tree', '-r', '-z', '--full-tree', commit], this.workTree)).toString('utf8');
    const tree = new Map<string, TreeEntry>();
    for (const record of out.split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      const [mode = '', type = '', oid = ''] = record.slice(0, tab).split(' ');
      if (type !== 'blob' || !TREE_MODES.has(mode)) continue;
      tree.set(record.slice(tab + 1), { mode: mode as TreeMode, oid });
    }
    return tree;
  }

  /** `git diff --name-status <a> <b>`, parsed from its NUL-terminated form. */
  async diffNameStatus(a: string, b: string): Promise<NameStatus[]> {
    const tokens = (await gitOk(['diff', '--name-status', '-z', '--no-color', a, b], this.workTree)).toString('utf8').split('\0');
    if (tokens.at(-1) === '') tokens.pop();
    const entries: NameStatus[] = [];
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i++] ?? '';
      if (status.startsWith('R') || status.startsWith('C')) {
        const oldPath = tokens[i++] ?? '';
        entries.push({ status, path: tokens[i++] ?? '', oldPath });
      } else {
        entries.push({ status, path: tokens[i++] ?? '' });
      }
    }
    return entries;
  }

  /**
   * Make `dir` a detached execution worktree whose HEAD, index and files are exactly `commit`.
   * An existing execution worktree is force-checked-out and cleaned of every untracked file except the
   * PRESERVED_ON_RESTORE secret paths. A `dir` that exists but is not the top level of its own worktree is
   * refused (ERR_WORKSPACE), and nothing is written.
   */
  async materialize(dir: string, commit: string): Promise<void> {
    let exists = true;
    try {
      await lstat(dir);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') throw err;
      exists = false;
    }

    if (exists) {
      const top = await runGit(['rev-parse', '--show-toplevel'], dir);
      const topPath = top.stdout.toString('utf8').trim();
      const own = top.code === 0 && topPath !== '' && (await realpath(topPath)) === (await realpath(dir));
      if (!own || (await realpath(dir)) === (await realpath(this.workTree))) {
        throw new EngineError('ERR_WORKSPACE', `${dir} exists and is not a ckpt execution worktree; refusing to overwrite it`);
      }
      await gitOk(['checkout', '--quiet', '--detach', '--force', commit], dir);
      await gitOk(['clean', '-ffdxq', ...PRESERVED_ON_RESTORE.flatMap((pattern) => ['-e', pattern])], dir);
      return;
    }

    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    // Drop registrations of worktrees whose directories are gone, so the name can be reused.
    await gitOk(['worktree', 'prune'], this.workTree);
    await gitOk(['worktree', 'add', '--detach', '--force', dir, commit], this.workTree);
  }
}
