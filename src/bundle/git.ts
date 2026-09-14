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

/** Object ids a commit, tree or tag points at (gitlinks excluded: they name another repository's commit). */
export function referencedObjects(type: GitObjectType, content: Buffer): string[] {
  if (type === 'blob') return [];
  const out: string[] = [];
  if (type === 'tree') {
    for (let at = 0; at < content.byteLength; ) {
      const space = content.indexOf(0x20, at);
      const nul = space === -1 ? -1 : content.indexOf(0, space);
      if (space === -1 || nul === -1 || nul + 21 > content.byteLength) throw malformed('git tree object is malformed');
      if (content.toString('latin1', at, space) !== '160000') out.push(content.toString('hex', nul + 1, nul + 21));
      at = nul + 21;
    }
    return out;
  }
  const headerEnd = content.indexOf('\n\n');
  const header = content.toString('utf8', 0, headerEnd === -1 ? content.byteLength : headerEnd);
  for (const line of header.split('\n')) {
    const match = /^(tree|parent|object) ([0-9a-f]{40})$/.exec(line);
    if (match) out.push(match[2]!);
  }
  if (type === 'commit' && !/^tree [0-9a-f]{40}$/m.test(header)) throw malformed('git commit object has no tree');
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
   * Write objects into the object database. Each must come back under its own id, or this fails. Objects
   * written here stay unreachable until a ref points at them.
   */
  async writeObjects(objects: readonly GitObject[], tmpDir: string): Promise<void> {
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
        const out = await this.#ok(['hash-object', '-w', '--no-filters', '-t', type, '--stdin-paths'], `${list.map((e) => e.file).join('\n')}\n`);
        const shas = out.toString('utf8').split('\n').filter((line) => line !== '');
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
