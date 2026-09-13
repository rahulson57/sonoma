/**
 * Git as the workspace backend (SPEC-005, DEC-002), through plumbing only.
 *
 * A checkpoint commit is built from a caller-sanitized staging directory without touching the user's
 * branches, index or worktree:
 *   1. a temporary index file (GIT_INDEX_FILE) under `.ckpt/tmp`, started empty (`read-tree --empty`);
 *   2. file blobs written with `hash-object -w --no-filters --stdin-paths` (no clean/smudge filters,
 *      attributes, ignore rules or LFS run on the staged bytes), symlinks hashed from their target;
 *   3. entries added with `update-index -z --index-info`, then `write-tree` and `commit-tree`;
 *   4. the ref under `refs/checkpoints/<run>/<checkpoint>` is written separately by `updateRef`, so the
 *      caller controls when the commit becomes visible.
 *
 * Every invocation strips inherited GIT_* variables (so a hook environment cannot redirect git at
 * another index or repository), disables hooks and system config, and never talks to a remote.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { StorageError } from './errors.js';

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const CONFIG_OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0'];

export const CHECKPOINT_IDENTITY = { name: 'ckpt', email: 'ckpt@localhost' } as const;

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra };
}

function execGit(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string | Uint8Array): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...CONFIG_OVERRIDES, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => reject(new StorageError('ERR_GIT', `could not run git: ${err.message}`, { cause: err })));
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => undefined); // git may exit before reading all input; `close` reports it
    child.stdin.end(input ?? '');
  });
}

export type StagedEntryKind = 'file' | 'executable' | 'symlink';

export interface StagedEntry {
  /** POSIX-style path relative to the staging root. */
  readonly path: string;
  readonly kind: StagedEntryKind;
}

/** Regular files and symlinks under `root`, sorted by path. `.git` entries and special files are skipped. */
export async function collectStagingTree(root: string): Promise<StagedEntry[]> {
  const entries: StagedEntry[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      if (name === '.git') continue;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (rel.includes('\n') || rel.includes('\0')) {
        throw new StorageError('ERR_INVALID_INPUT', `staging tree path contains a newline or NUL: ${JSON.stringify(rel)}`);
      }
      const abs = path.join(dir, name);
      const st = await lstat(abs);
      if (st.isDirectory()) await walk(abs, rel);
      else if (st.isSymbolicLink()) entries.push({ path: rel, kind: 'symlink' });
      else if (st.isFile()) entries.push({ path: rel, kind: (st.mode & 0o111) !== 0 ? 'executable' : 'file' });
    }
  };
  await walk(root, '');
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface CommitTreeOptions {
  readonly parent: string | null;
  readonly message: string;
  /** Epoch ms used for author and committer dates (injected clock). */
  readonly timeMs: number;
  /** Directory for the temporary index (must be on the store's filesystem, e.g. `.ckpt/tmp`). */
  readonly tmpDir: string;
}

export class GitRepo {
  readonly gitDir: string;
  readonly workTree: string;

  private constructor(gitDir: string, workTree: string) {
    this.gitDir = gitDir;
    this.workTree = workTree;
  }

  static async open(repoDir: string): Promise<GitRepo> {
    const result = await execGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], repoDir, baseEnv({}));
    const [workTree, gitDir] = result.stdout.split('\n');
    if (result.code !== 0 || !workTree || !gitDir) {
      throw new StorageError('ERR_GIT', `${repoDir} is not inside a git worktree: ${result.stderr.trim()}`);
    }
    return new GitRepo(gitDir, workTree);
  }

  async #run(args: readonly string[], options: { cwd?: string; env?: Record<string, string>; input?: string | Uint8Array } = {}): Promise<GitResult> {
    return execGit(args, options.cwd ?? this.workTree, baseEnv({ GIT_DIR: this.gitDir, ...options.env }), options.input);
  }

  async #ok(args: readonly string[], options: { cwd?: string; env?: Record<string, string>; input?: string | Uint8Array } = {}): Promise<string> {
    const result = await this.#run(args, options);
    if (result.code !== 0) {
      throw new StorageError('ERR_GIT', `git ${args[0] ?? ''} failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  /** Build a commit of `stagingDir` through a temporary index. Writes objects only; no ref moves. */
  async commitTree(stagingDir: string, options: CommitTreeOptions): Promise<{ tree: string; commit: string }> {
    const st = await stat(stagingDir).catch(() => undefined);
    if (!st?.isDirectory()) {
      throw new StorageError('ERR_INVALID_INPUT', `stagingDir is not a directory: ${JSON.stringify(stagingDir)}`);
    }
    const entries = await collectStagingTree(stagingDir);
    const work = await mkdtemp(path.join(options.tmpDir, 'index-'));
    try {
      const env = { GIT_INDEX_FILE: path.join(work, 'index') };
      await this.#ok(['read-tree', '--empty'], { env });

      const records: string[] = [];
      const files = entries.filter((entry) => entry.kind !== 'symlink');
      if (files.length > 0) {
        const out = await this.#ok(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
          cwd: stagingDir,
          env,
          input: `${files.map((entry) => entry.path).join('\n')}\n`,
        });
        const shas = out.split('\n').filter((line) => line !== '');
        if (shas.length !== files.length) {
          throw new StorageError('ERR_GIT', `hash-object returned ${shas.length} ids for ${files.length} files`);
        }
        files.forEach((entry, i) => {
          records.push(`${entry.kind === 'executable' ? '100755' : '100644'} ${shas[i] ?? ''}\t${entry.path}\0`);
        });
      }
      for (const entry of entries.filter((candidate) => candidate.kind === 'symlink')) {
        const target = await readlink(path.join(stagingDir, entry.path), { encoding: 'buffer' });
        const sha = (await this.#ok(['hash-object', '-w', '--no-filters', '--stdin'], { cwd: stagingDir, env, input: target })).trim();
        records.push(`120000 ${sha}\t${entry.path}\0`);
      }
      if (records.length > 0) {
        await this.#ok(['update-index', '--add', '-z', '--index-info'], { cwd: stagingDir, env, input: records.join('') });
      }

      const tree = (await this.#ok(['write-tree'], { env })).trim();
      const date = `${Math.floor(options.timeMs / 1000)} +0000`;
      const commit = (
        await this.#ok(['commit-tree', '--no-gpg-sign', tree, ...(options.parent ? ['-p', options.parent] : []), '-m', options.message], {
          env: {
            ...env,
            GIT_AUTHOR_NAME: CHECKPOINT_IDENTITY.name,
            GIT_AUTHOR_EMAIL: CHECKPOINT_IDENTITY.email,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: CHECKPOINT_IDENTITY.name,
            GIT_COMMITTER_EMAIL: CHECKPOINT_IDENTITY.email,
            GIT_COMMITTER_DATE: date,
          },
        })
      ).trim();
      return { tree, commit };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Point `ref` (must be under refs/checkpoints/) at `sha`. */
  async updateRef(ref: string, sha: string): Promise<void> {
    if (!ref.startsWith('refs/checkpoints/')) {
      throw new StorageError('ERR_INVALID_INPUT', `Local Storage only writes refs/checkpoints/*, not ${ref}`);
    }
    await this.#ok(['update-ref', '--no-deref', ref, sha]);
  }

  /** refname → object id for every ref under `prefix` (e.g. `refs/checkpoints/<run>/`). */
  async listRefs(prefix: string): Promise<Map<string, string>> {
    const out = await this.#ok(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
    const refs = new Map<string, string>();
    for (const line of out.split('\n')) {
      const [name, sha] = line.split(' ');
      if (name && sha) refs.set(name, sha);
    }
    return refs;
  }
}
