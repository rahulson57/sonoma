/**
 * Git as the workspace backend (SPEC-005, DEC-002), through plumbing only.
 *
 * A checkpoint commit is built without touching the user's branches, index or worktree, through a
 * temporary index file (GIT_INDEX_FILE) under `.ckpt/tmp`:
 *
 * - Full build (no parent commit, or no `changes`): walk the caller-sanitized staging directory and add
 *   every regular file and symlink to an empty index.
 * - Incremental build (a parent commit plus `changes`, DEC-019(1)): `read-tree` the parent commit into
 *   the temporary index, hash only `changes.written` from the staging directory, and apply the written
 *   and deleted entries. Unchanged files are never opened or stat'ed. A delta that does not fit the
 *   staging directory or the parent tree fails with ERR_INVALID_CHANGES before any object is written.
 *
 * Both builds write blobs with `hash-object -w --no-filters --stdin-paths` (no clean/smudge filters,
 * attributes, ignore rules or LFS run on the staged bytes; a symlink's blob is its target bytes), then
 * run `update-index -z --index-info`, `write-tree` and `commit-tree`. The ref under
 * `refs/checkpoints/<run>/<checkpoint>` is written separately by `updateRef`, so the caller controls when
 * the commit becomes visible.
 *
 * Paths reach git byte-exact (DEC-019(2)). `--index-info` and `ls-files` are NUL-terminated.
 * `--stdin-paths` is line-based: git C-unquotes a line that starts with `"` and strips a trailing CR, so
 * every path that is not plain printable ASCII is sent C-quoted.
 *
 * Every invocation strips inherited GIT_* variables (so a hook environment cannot redirect git at
 * another index or repository), disables hooks and system config, and never talks to a remote.
 */
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StorageError } from './errors.js';
import { errnoCode } from './fs-util.js';
import type { WorkspaceChanges } from './types.js';

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

function invalidChanges(message: string): StorageError {
  return new StorageError('ERR_INVALID_CHANGES', message);
}

/** A `--stdin-paths` line git reads back verbatim: printable ASCII that does not start with `"`. */
const VERBATIM_STDIN_PATH = /^[\x20\x21\x23-\x7e][\x20-\x7e]*$/;

/**
 * Encode `p` as one `hash-object --stdin-paths` line (without the newline). Plain printable ASCII goes
 * as is. Anything else is C-quoted byte by byte over its UTF-8 encoding (`\"`, `\\`, octal escapes),
 * which git unquotes back to exactly those bytes.
 */
export function quoteStdinPath(p: string): string {
  if (VERBATIM_STDIN_PATH.test(p)) return p;
  let out = '"';
  for (const byte of Buffer.from(p, 'utf8')) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += '\\\\';
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${out}"`;
}

/** Why `p` is not a canonical repo-relative POSIX path a checkpoint tree can hold, or null if it is. */
export function repoPathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return 'is not a non-empty string';
  if (p.includes('\0')) return 'contains NUL';
  if (/\p{Cs}/u.test(p)) return 'is not well-formed Unicode';
  for (const segment of p.split('/')) {
    if (segment === '') return 'is not a canonical relative path (leading, trailing or doubled "/")';
    if (segment === '.' || segment === '..') return 'contains a "." or ".." segment';
    if (segment === '.git') return 'contains a ".git" segment';
  }
  return null;
}

/** Copy a `changes` delta, checking its shape and path syntax (ERR_INVALID_CHANGES). */
export function checkWorkspaceChanges(value: unknown): WorkspaceChanges {
  const shape = 'changes is {written: string[], deleted: string[]}';
  if (typeof value !== 'object' || value === null) throw invalidChanges(shape);
  const { written, deleted } = value as { written?: unknown; deleted?: unknown };
  if (!Array.isArray(written) || !Array.isArray(deleted)) throw invalidChanges(shape);
  for (const p of [...written, ...deleted] as unknown[]) {
    const problem = repoPathProblem(p);
    if (problem !== null) throw invalidChanges(`changes path ${JSON.stringify(p)} ${problem}`);
  }
  return { written: [...written] as string[], deleted: [...deleted] as string[] };
}

/** Code point order of two strings, which is the byte order of their UTF-8 encodings (git's index order). */
function compareGitPaths(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x !== y) {
      // UTF-16 units sort surrogates below U+E000–U+FFFF; code points (and UTF-8) sort them above.
      if (x >= 0xd800) x += x < 0xe000 ? 0x2000 : -0x800;
      if (y >= 0xd800) y += y < 0xe000 ? 0x2000 : -0x800;
      return x - y;
    }
  }
  return a.length - b.length;
}

/** Whether `sorted` (git index order) holds an entry under `dirPrefix` (ending in "/") that is not deleted. */
function hasLiveEntryUnder(sorted: readonly string[], dirPrefix: string, deleted: ReadonlySet<string>): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareGitPaths(sorted[mid] ?? '', dirPrefix) < 0) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < sorted.length; i += 1) {
    const entry = sorted[i] ?? '';
    if (!entry.startsWith(dirPrefix)) break;
    if (!deleted.has(entry)) return true;
  }
  return false;
}

/** Each proper directory prefix of `p` ("a/b/c" → "a", "a/b"). */
function* parentDirs(p: string): Generator<string> {
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) yield p.slice(0, i);
}

export type StagedEntryKind = 'file' | 'executable' | 'symlink';

const INDEX_MODE: Record<StagedEntryKind, string> = { file: '100644', executable: '100755', symlink: '120000' };

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
      const abs = path.join(dir, name);
      let st;
      try {
        st = await lstat(abs);
      } catch (err) {
        // readdir decodes names as UTF-8; a name that is not valid UTF-8 comes back altered and cannot be found.
        if (errnoCode(err) === 'ENOENT' && name.includes('\uFFFD')) {
          throw new StorageError('ERR_INVALID_INPUT', `staging tree name is not valid UTF-8: ${JSON.stringify(rel)}`);
        }
        throw err;
      }
      if (st.isDirectory()) await walk(abs, rel);
      else if (st.isSymbolicLink()) entries.push({ path: rel, kind: 'symlink' });
      else if (st.isFile()) entries.push({ path: rel, kind: (st.mode & 0o111) !== 0 ? 'executable' : 'file' });
    }
  };
  await walk(root, '');
  return entries.sort((a, b) => compareGitPaths(a.path, b.path));
}

export interface CommitTreeOptions {
  /** Git parent of the new commit. With `changes`, also the tree the commit is built on. */
  readonly parent: string | null;
  /**
   * Delta from the parent commit's tree (DEC-019(1)). Used only when `parent` is set: then only
   * `written` is read from the staging directory. Without a parent the staging directory is built in full.
   */
  readonly changes?: WorkspaceChanges;
  readonly message: string;
  /** Epoch ms used for author and committer dates (injected clock). */
  readonly timeMs: number;
  /** Directory for the temporary index (must be on the store's filesystem, e.g. `.ckpt/tmp`). */
  readonly tmpDir: string;
}

export interface CommitTreeResult {
  readonly tree: string;
  readonly commit: string;
  /** How many staged files and symlinks were read from the staging directory. */
  readonly hashed: number;
}

type IndexEnv = { readonly GIT_INDEX_FILE: string };

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
  async commitTree(stagingDir: string, options: CommitTreeOptions): Promise<CommitTreeResult> {
    const st = await stat(stagingDir).catch(() => undefined);
    if (!st?.isDirectory()) {
      throw new StorageError('ERR_INVALID_INPUT', `stagingDir is not a directory: ${JSON.stringify(stagingDir)}`);
    }
    const work = await mkdtemp(path.join(options.tmpDir, 'index-'));
    try {
      const env: IndexEnv = { GIT_INDEX_FILE: path.join(work, 'index') };

      let records: string[];
      let hashed: number;
      if (options.parent !== null && options.changes !== undefined) {
        ({ records, hashed } = await this.#deltaRecords(stagingDir, options.parent, options.changes, env, work));
      } else {
        // A fresh, not-yet-existing index file is an empty index: update-index creates it and
        // write-tree of a missing index yields the empty tree, so no `read-tree --empty` spawn is needed.
        const entries = await collectStagingTree(stagingDir);
        records = await this.#hashEntries(stagingDir, entries, env, work);
        hashed = entries.length;
      }
      if (records.length > 0) {
        await this.#ok(['update-index', '--add', '-z', '--index-info'], { cwd: work, env, input: records.join('') });
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
      return { tree, commit, hashed };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * Load `parent`'s tree into the temporary index and turn `changes` into `--index-info` records
   * (removals first). Everything is validated before the first object is written.
   */
  async #deltaRecords(
    stagingDir: string,
    parent: string,
    input: WorkspaceChanges,
    env: IndexEnv,
    work: string,
  ): Promise<{ records: string[]; hashed: number }> {
    const changes = checkWorkspaceChanges(input);
    const written = new Set(changes.written);
    const deleted = new Set(changes.deleted);
    for (const p of written) {
      if (deleted.has(p)) throw invalidChanges(`${JSON.stringify(p)} is both written and deleted`);
    }

    const additions: StagedEntry[] = [];
    for (const p of written) {
      let st;
      try {
        st = await lstat(path.join(stagingDir, p));
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') throw invalidChanges(`written path ${JSON.stringify(p)} is not in stagingDir`);
        throw err;
      }
      if (st.isSymbolicLink()) additions.push({ path: p, kind: 'symlink' });
      else if (st.isFile()) additions.push({ path: p, kind: (st.mode & 0o111) !== 0 ? 'executable' : 'file' });
      else throw invalidChanges(`written path ${JSON.stringify(p)} is not a regular file or symlink in stagingDir`);
    }

    await this.#ok(['read-tree', parent], { cwd: work, env });
    const parentPaths = (await this.#ok(['ls-files', '-z'], { cwd: work, env })).split('\0');
    parentPaths.pop(); // the empty string after the final NUL (or of an empty tree)
    const inParent = new Set(parentPaths);
    for (const p of deleted) {
      if (!inParent.has(p)) throw invalidChanges(`deleted path ${JSON.stringify(p)} is not a file in the parent tree`);
    }

    // update-index silently drops an entry that a new entry displaces (a file where a directory was, or
    // the reverse), so the delta must account for every entry it displaces.
    const remains = (p: string): boolean => written.has(p) || (inParent.has(p) && !deleted.has(p));
    const writtenDirs = new Set<string>();
    for (const p of written) for (const dir of parentDirs(p)) writtenDirs.add(dir);
    for (const p of written) {
      for (const dir of parentDirs(p)) {
        if (remains(dir)) throw invalidChanges(`written path ${JSON.stringify(p)} is inside ${JSON.stringify(dir)}, which remains a file`);
      }
      if (writtenDirs.has(p) || hasLiveEntryUnder(parentPaths, `${p}/`, deleted)) {
        throw invalidChanges(`written path ${JSON.stringify(p)} is a directory that still holds files`);
      }
    }

    const zeroOid = '0'.repeat(parent.length);
    const removals = [...deleted].map((p) => `0 ${zeroOid}\t${p}\0`);
    return { records: [...removals, ...(await this.#hashEntries(stagingDir, additions, env, work))], hashed: additions.length };
  }

  /** Write the blobs of `entries` (read from `stagingDir`) in one hash-object run; returns `--index-info` records. */
  async #hashEntries(stagingDir: string, entries: readonly StagedEntry[], env: IndexEnv, work: string): Promise<string[]> {
    if (entries.length === 0) return [];
    const lines: string[] = [];
    for (const [i, entry] of entries.entries()) {
      if (entry.kind === 'symlink') {
        // A symlink's blob is its target bytes. Hashing a private copy keeps every entry in one hash-object run.
        const copy = path.join(work, `link-${i}`);
        await writeFile(copy, await readlink(path.join(stagingDir, entry.path), { encoding: 'buffer' }), { mode: 0o600 });
        lines.push(quoteStdinPath(copy));
      } else {
        lines.push(quoteStdinPath(entry.path));
      }
    }
    const out = await this.#ok(['hash-object', '-w', '--no-filters', '--stdin-paths'], { cwd: stagingDir, env, input: `${lines.join('\n')}\n` });
    const shas = out.split('\n').filter((line) => line !== '');
    if (shas.length !== entries.length) {
      throw new StorageError('ERR_GIT', `hash-object returned ${shas.length} ids for ${entries.length} entries`);
    }
    return entries.map((entry, i) => `${INDEX_MODE[entry.kind]} ${shas[i] ?? ''}\t${entry.path}\0`);
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
