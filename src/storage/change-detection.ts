/**
 * Change detection (SPEC-005): a per-run index of `path → size, mtime, inode, sha256`.
 *
 * Size, mtime and inode all unchanged ⇒ the file is a candidate-unchanged and is NOT read; its cached
 * sha256 is reused. Anything else ⇒ the file is rehashed (whole file, streamed; no chunking in v1).
 *
 * mtime is an optimisation, rehash is the correctness backstop. Like git's "racily clean" rule, an
 * entry whose mtime is within RACY_WINDOW_NS of the moment it was hashed is not trusted, because a
 * second write inside the filesystem's timestamp granularity would leave size and mtime unchanged.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StorageError } from './errors.js';
import { errnoCode } from './fs-util.js';

export interface FileStatInfo {
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ino: bigint;
}

/** The filesystem surface change detection uses; injectable so tests can count reads. */
export interface ChangeDetectionFs {
  stat(absPath: string): Promise<FileStatInfo>;
  createReadStream(absPath: string): Readable;
}

export const nodeChangeDetectionFs: ChangeDetectionFs = {
  async stat(absPath) {
    const st = await stat(absPath, { bigint: true });
    return { size: Number(st.size), mtimeNs: st.mtimeNs, ino: st.ino };
  },
  createReadStream(absPath) {
    return createReadStream(absPath);
  },
};

export interface FileCacheEntry {
  readonly path: string;
  readonly size: number;
  /** Decimal nanoseconds. */
  readonly mtimeNs: string;
  /** Decimal inode number. */
  readonly inode: string;
  readonly sha256: string;
  /** Decimal nanoseconds (injected clock) at which sha256 was computed. */
  readonly hashedAtNs: string;
}

/** Per-run cache store (backed by checkpoint.db in LocalBackend; any map works). */
export interface FileCache {
  get(relPath: string): FileCacheEntry | undefined;
  set(entry: FileCacheEntry): void;
  delete(relPath: string): void;
  paths(): string[];
}

export type FileChangeStatus = 'added' | 'modified' | 'unchanged';

export interface DetectedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly status: FileChangeStatus;
  /** Whether the file's bytes were read (rehashed) in this pass. */
  readonly reread: boolean;
}

export interface ChangeDetectionResult {
  readonly files: DetectedFile[];
  /** Cached paths that are no longer present (and were dropped from the cache). */
  readonly removed: string[];
  readonly rehashed: number;
}

/** 2 s: covers 1 s (ext3, HFS+) and 2 s (FAT) mtime granularity. */
export const RACY_WINDOW_NS = 2_000_000_000n;

export interface ChangeDetectorOptions {
  /** Workspace root the relative paths are resolved against. */
  readonly root: string;
  readonly cache: FileCache;
  readonly fs?: ChangeDetectionFs;
  /** Epoch nanoseconds. Defaults to the system clock. */
  readonly nowNs?: () => bigint;
}

function normalizeRelPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath === '' || path.isAbsolute(relPath)) {
    throw new StorageError('ERR_INVALID_INPUT', `change detection paths must be relative, got ${JSON.stringify(relPath)}`);
  }
  const normalized = path.posix.normalize(relPath.split(path.sep).join('/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new StorageError('ERR_INVALID_INPUT', `change detection path escapes the root: ${JSON.stringify(relPath)}`);
  }
  return normalized;
}

export class ChangeDetector {
  readonly #root: string;
  readonly #cache: FileCache;
  readonly #fs: ChangeDetectionFs;
  readonly #nowNs: () => bigint;

  constructor(options: ChangeDetectorOptions) {
    this.#root = options.root;
    this.#cache = options.cache;
    this.#fs = options.fs ?? nodeChangeDetectionFs;
    this.#nowNs = options.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
  }

  /**
   * Classify `relPaths` (the workspace's current file list) against the cache, rehashing only
   * candidates that may have changed, and update the cache.
   */
  async detect(relPaths: readonly string[]): Promise<ChangeDetectionResult> {
    const seen = new Set<string>();
    const files: DetectedFile[] = [];
    let rehashed = 0;

    for (const raw of relPaths) {
      const relPath = normalizeRelPath(raw);
      if (seen.has(relPath)) continue;
      const absPath = path.join(this.#root, ...relPath.split('/'));

      let st: FileStatInfo;
      try {
        st = await this.#fs.stat(absPath);
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') continue; // vanished since listing: reported as removed below
        throw err;
      }
      seen.add(relPath);

      const cached = this.#cache.get(relPath);
      const mtimeNs = st.mtimeNs.toString();
      const inode = st.ino.toString();
      if (
        cached !== undefined &&
        cached.size === st.size &&
        cached.mtimeNs === mtimeNs &&
        cached.inode === inode &&
        st.mtimeNs + RACY_WINDOW_NS < BigInt(cached.hashedAtNs)
      ) {
        files.push({ path: relPath, size: st.size, sha256: cached.sha256, status: 'unchanged', reread: false });
        continue;
      }

      const hashedAtNs = this.#nowNs();
      const sha256 = await this.#hash(absPath);
      rehashed += 1;
      const status: FileChangeStatus = cached === undefined ? 'added' : cached.sha256 === sha256 ? 'unchanged' : 'modified';
      this.#cache.set({ path: relPath, size: st.size, mtimeNs, inode, sha256, hashedAtNs: hashedAtNs.toString() });
      files.push({ path: relPath, size: st.size, sha256, status, reread: true });
    }

    const removed = this.#cache.paths().filter((cachedPath) => !seen.has(cachedPath)).sort();
    for (const gone of removed) this.#cache.delete(gone);
    return { files, removed, rehashed };
  }

  async #hash(absPath: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.#fs.createReadStream(absPath)) hash.update(chunk as Uint8Array);
    return hash.digest('hex');
  }
}
