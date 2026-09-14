/**
 * Git plumbing for bundles (SPEC-011): enumerate and read the objects behind refs/checkpoints/*, and
 * write them back on import.
 *
 * Local Storage's GitRepo (src/storage/git.ts) keeps its process runner private and exposes only what
 * checkpoints need, so the few extra read/write plumbing commands a bundle needs run here, under the
 * same isolation rules: inherited GIT_* variables stripped, system config and hooks disabled, optional
 * locks off, and never a remote. Refs are listed through GitRepo.listRefs.
 *
 * Objects travel in their loose-object encoding, `<type> <size>\0<content>`, whose sha1 IS the object
 * id. So a bundle entry is verified with a hash, without git and before anything is written.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitRepo } from '../storage/git.js';
import { BundleError } from './errors.js';

export const GIT_SHA = /^[0-9a-f]{40}$/;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly sha: string;
  readonly type: GitObjectType;
  readonly content: Buffer;
}

export interface GitObjectInfo {
  readonly type: GitObjectType;
  readonly size: number;
}

export interface TreeFile {
  /** Repo-relative path in the commit's tree. */
  readonly path: string;
  readonly mode: string;
  readonly sha: string;
}

const CONFIG_OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0'];

interface ExecResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function execGit(args: readonly string[], cwd: string, gitDir: string, input?: string): Promise<ExecResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_DIR: gitDir });
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...CONFIG_OVERRIDES, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => reject(new BundleError('ERR_GIT', `could not run git: ${err.message}`, { cause: err })));
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => undefined); // git may exit before reading all input; `close` reports it
    child.stdin.end(input ?? '');
  });
}

/** `<type> <size>\0<content>`: the bytes whose sha1 is the object id. */
export function encodeGitObject(type: GitObjectType, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${content.byteLength}\0`, 'ascii'), content]);
}

export function gitObjectId(encoded: Uint8Array): string {
  return createHash('sha1').update(encoded).digest('hex');
}

function malformed(message: string): BundleError {
  return new BundleError('ERR_INVALID_BUNDLE', message);
}

export function decodeGitObject(encoded: Buffer): { type: GitObjectType; content: Buffer } {
  const nul = encoded.indexOf(0);
  const header = nul === -1 || nul > 32 ? null : /^(commit|tree|blob|tag) (0|[1-9][0-9]*)$/.exec(encoded.toString('latin1', 0, nul));
  if (header === null) throw malformed('git object entry has no valid `<type> <size>` header');
  const content = encoded.subarray(nul + 1);
  if (Number(header[2]) !== content.byteLength) throw malformed('git object entry size does not match its header');
  return { type: header[1] as GitObjectType, content };
}

/** An object another object points at, and the type the pointing object requires it to have. */
export interface ObjectReference {
  readonly sha: string;
  readonly type: GitObjectType;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFGITLINK = 0o160000;

/**
 * Objects a commit, tree or tag points at, each with the type it must have: a commit's tree is a tree
 * and its parents are commits; a tag's object has the tag's `type`; a tree entry is a tree when its mode
 * is a directory, and otherwise a blob (git's own rule, object_type(mode)). Gitlinks are excluded,
 * because they name another repository's commit.
 *
 * git's format check (hash-object) does not look at referenced objects, so a caller walking a graph must
 * compare these types itself.
 */
export function referencedObjects(type: GitObjectType, content: Buffer): ObjectReference[] {
  if (type === 'blob') return [];
  const out: ObjectReference[] = [];
  if (type === 'tree') {
    for (let at = 0; at < content.byteLength; ) {
      const space = content.indexOf(0x20, at);
      const nul = space === -1 ? -1 : content.indexOf(0, space);
      if (space === -1 || nul === -1 || nul + 21 > content.byteLength) throw malformed('git tree object is malformed');
      const mode = content.toString('latin1', at, space);
      if (!/^[0-7]{1,6}$/.test(mode)) throw malformed(`git tree entry mode ${JSON.stringify(mode)} is malformed`);
      const format = Number.parseInt(mode, 8) & S_IFMT;
      if (format !== S_IFGITLINK) out.push({ sha: content.toString('hex', nul + 1, nul + 21), type: format === S_IFDIR ? 'tree' : 'blob' });
      at = nul + 21;
    }
    return out;
  }
  const headerEnd = content.indexOf('\n\n');
  const lines = content.toString('utf8', 0, headerEnd === -1 ? content.byteLength : headerEnd).split('\n');
  if (type === 'commit') {
    for (const line of lines) {
      const match = /^(tree|parent) ([0-9a-f]{40})$/.exec(line);
      if (match) out.push({ sha: match[2]!, type: match[1] === 'tree' ? 'tree' : 'commit' });
    }
    if (!out.some((ref) => ref.type === 'tree')) throw malformed('git commit object has no tree');
    return out;
  }
  const object = lines.map((line) => /^object ([0-9a-f]{40})$/.exec(line)).find((match) => match !== null);
  const target = lines.map((line) => /^type (commit|tree|blob|tag)$/.exec(line)).find((match) => match !== null);
  if (object == null || target == null) throw malformed('git tag object has no object or type');
  out.push({ sha: object[1]!, type: target[1] as GitObjectType });
  return out;
}

export class BundleGit {
  readonly repo: GitRepo;

  private constructor(repo: GitRepo) {
    this.repo = repo;
  }

  static async open(repoDir: string): Promise<BundleGit> {
    return new BundleGit(await GitRepo.open(repoDir));
  }

  async #ok(args: readonly string[], input?: string): Promise<Buffer> {
    const result = await execGit(args, this.repo.workTree, this.repo.gitDir, input);
    if (result.code !== 0) {
      throw new BundleError('ERR_GIT', `git ${args[0] ?? ''} failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  listRefs(prefix: string): Promise<Map<string, string>> {
    return this.repo.listRefs(prefix);
  }

  /** Every object reachable from `commits` (commits, trees, blobs), each once. */
  async closure(commits: readonly string[]): Promise<string[]> {
    if (commits.length === 0) return [];
    const out = await this.#ok(['rev-list', '--objects', '--stdin'], `${commits.join('\n')}\n`);
    const seen = new Set<string>();
    for (const line of out.toString('utf8').split('\n')) {
      const sha = line.slice(0, 40);
      if (GIT_SHA.test(sha)) seen.add(sha);
    }
    return [...seen];
  }

  /** Type and size of each object; a missing object maps to null. */
  async inspect(shas: readonly string[]): Promise<Map<string, GitObjectInfo | null>> {
    const info = new Map<string, GitObjectInfo | null>();
    if (shas.length === 0) return info;
    const out = await this.#ok(['cat-file', '--batch-check'], `${shas.join('\n')}\n`);
    for (const line of out.toString('utf8').split('\n')) {
      const found = /^([0-9a-f]{40}) (commit|tree|blob|tag) (\d+)$/.exec(line);
      if (found) {
        info.set(found[1]!, { type: found[2] as GitObjectType, size: Number(found[3]) });
        continue;
      }
      const missing = /^([0-9a-f]{40}) missing$/.exec(line);
      if (missing) info.set(missing[1]!, null);
    }
    return info;
  }

  /** The objects' content, in the order asked. */
  async readObjects(shas: readonly string[]): Promise<GitObject[]> {
    if (shas.length === 0) return [];
    const out = await this.#ok(['cat-file', '--batch'], `${shas.join('\n')}\n`);
    const objects: GitObject[] = [];
    let at = 0;
    for (const sha of shas) {
      const eol = out.indexOf(0x0a, at);
      const header = eol === -1 ? null : /^([0-9a-f]{40}) (commit|tree|blob|tag) (\d+)$/.exec(out.toString('utf8', at, eol));
      if (header === null || header[1] !== sha) throw new BundleError('ERR_CORRUPT_STORE', `git object ${sha} could not be read`);
      const start = eol + 1;
      const size = Number(header[3]);
      if (start + size > out.byteLength) throw new BundleError('ERR_GIT', `git cat-file output for ${sha} is truncated`);
      objects.push({ sha, type: header[2] as GitObjectType, content: out.subarray(start, start + size) });
      at = start + size + 1;
    }
    return objects;
  }

  /** Every blob of `commit`'s tree, with byte-exact (-z) paths. */
  async treeFiles(commit: string): Promise<TreeFile[]> {
    const out = await this.#ok(['ls-tree', '-r', '-z', '--full-tree', commit]);
    const files: TreeFile[] = [];
    for (const record of out.toString('utf8').split('\0')) {
      if (record === '') continue;
      const tab = record.indexOf('\t');
      const [mode = '', type = '', sha = ''] = record.slice(0, tab).split(' ');
      if (type === 'blob') files.push({ path: record.slice(tab + 1), mode, sha });
    }
    return files;
  }

  /**
   * Run git's own object format check (the one `hash-object -w` applies: tree entries, commit and tag
   * headers) on each object WITHOUT writing it. Each must also hash to its own id. A malformed object
   * fails with ERR_INVALID_BUNDLE.
   */
  checkObjects(objects: readonly GitObject[], tmpDir: string): Promise<void> {
    return this.#hashObjects(objects, tmpDir, false);
  }

  /**
   * Write objects into the object database. Each must come back under its own id, or this fails. Objects
   * written here stay unreachable until a ref points at them.
   */
  writeObjects(objects: readonly GitObject[], tmpDir: string): Promise<void> {
    return this.#hashObjects(objects, tmpDir, true);
  }

  async #hashObjects(objects: readonly GitObject[], tmpDir: string, write: boolean): Promise<void> {
    if (objects.length === 0) return;
    const work = await mkdtemp(path.join(tmpDir, 'bundle-objects-'));
    try {
      const byType = new Map<GitObjectType, Array<{ file: string; sha: string }>>();
      for (const [i, object] of objects.entries()) {
        const file = path.join(work, `o${i}`);
        await writeFile(file, object.content, { mode: 0o600 });
        const list = byType.get(object.type) ?? [];
        list.push({ file, sha: object.sha });
        byType.set(object.type, list);
      }
      for (const [type, list] of byType) {
        const args = ['hash-object', ...(write ? ['-w'] : []), '--no-filters', '-t', type, '--stdin-paths'];
        const result = await execGit(args, this.repo.workTree, this.repo.gitDir, `${list.map((e) => e.file).join('\n')}\n`);
        if (result.code !== 0) {
          if (write) throw new BundleError('ERR_GIT', `git hash-object failed (exit ${result.code}): ${result.stderr.trim()}`);
          throw new BundleError('ERR_INVALID_BUNDLE', `a bundled git ${type} object is malformed: ${result.stderr.trim()}`);
        }
        const shas = result.stdout.toString('utf8').split('\n').filter((line) => line !== '');
        list.forEach((entry, i) => {
          if (shas[i] !== entry.sha) {
            throw new BundleError('ERR_TAMPERED', `git object ${entry.sha} was stored as ${shas[i] ?? 'nothing'}`);
          }
        });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Create every ref in one git transaction: all of them or none, and never over an existing ref. */
  async createRefs(refs: ReadonlyArray<{ readonly ref: string; readonly sha: string }>): Promise<void> {
    if (refs.length === 0) return;
    for (const { ref, sha } of refs) {
      if (!ref.startsWith('refs/checkpoints/') || !GIT_SHA.test(sha)) {
        throw new BundleError('ERR_INVALID_BUNDLE', `import only writes refs/checkpoints/*, not ${JSON.stringify(ref)}`);
      }
    }
    await this.#ok(['update-ref', '--stdin'], refs.map(({ ref, sha }) => `create ${ref} ${sha}\n`).join(''));
  }

  /** Delete refs that still point at the given ids (rollback of createRefs). */
  async deleteRefs(refs: ReadonlyArray<{ readonly ref: string; readonly sha: string }>): Promise<void> {
    if (refs.length === 0) return;
    await this.#ok(['update-ref', '--stdin'], refs.map(({ ref, sha }) => `delete ${ref} ${sha}\n`).join(''));
  }
}
