/**
 * The sanitized staging tree (SPEC-003 "Git", DEC-002): what a checkpoint commit is built from.
 *
 * Snapshot policy, in order, per path (directories are pruned by the same rules):
 * 1. `.git` (any letter case) is never walked, and at the root of the user's worktree neither is the store
 *    (`.ckpt`).
 * 2. SPEC-003 hard-excluded secret paths (`isExcludedPath`) are never read.
 * 3. An optional caller filter (the configurable gitignore snapshot policy) may drop more.
 * 4. A regular file over the SPEC-002 1 GB limit is not read and is reported for a
 *    `workspace.file_skipped` event.
 * Every remaining file's bytes (and every symlink's target) pass through Redaction before they are staged:
 * valid UTF-8 up to 64 MB through `sanitize()`, anything else through the byte-exact windowed `scanBytes()`
 * with each hit replaced by its redaction marker, so a clean binary file is committed byte-identical.
 *
 * Incremental (SPEC-005 change detection, DEC-019(1)): with a parent commit, only files whose sanitized
 * blob differs from the parent tree are staged, and storage gets the `{written, deleted}` delta. A
 * per-run cache of `path → size, mtime, inode, mode, sanitized blob id` built from the previous checkpoint
 * lets unchanged files skip reading entirely. Rehash is the correctness backstop: any stat difference, or
 * an mtime within RACY_WINDOW_NS of the moment the file was hashed, re-reads the file.
 */
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanBytes } from '../redact/bundle.js';
import { redactionMarker } from '../redact/detectors.js';
import { isExcludedPath, sanitize } from '../redact/index.js';
import { RACY_WINDOW_NS } from '../storage/change-detection.js';
import { errnoCode } from '../storage/fs-util.js';
import type { WorkspaceChanges } from '../storage/types.js';

/** SPEC-002 "Single file in snapshot: 1 GB". */
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024 * 1024;
/** Valid UTF-8 up to this size is redacted as text with `sanitize()`; larger or binary content by windowed byte scan. */
export const TEXT_SANITIZE_MAX_BYTES = 64 * 1024 * 1024;

export type TreeMode = '100644' | '100755' | '120000';
export type ObjectFormat = 'sha1' | 'sha256';

export interface TreeEntry {
  readonly mode: TreeMode;
  readonly oid: string;
}

export interface SnapshotFile extends TreeEntry {
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ino: bigint;
  /** Epoch ns at which the file was read (racy-clean guard). */
  readonly hashedAtNs: bigint;
}

/** The tree of `baseCommit` together with the stats of the workspace files it was built from. */
export interface SnapshotCache {
  readonly workspaceDir: string;
  readonly baseCommit: string;
  readonly files: ReadonlyMap<string, SnapshotFile>;
}

export interface SkippedFile {
  readonly path: string;
  readonly size: number | null;
  readonly reason: 'too_large' | 'unreadable_name';
}

export interface SnapshotOptions {
  readonly workspaceDir: string;
  /** The tree the checkpoint builds on (parent checkpoint, or a fork's source), or null for a full build. */
  readonly parentCommit: string | null;
  readonly readTree: (commit: string) => Promise<ReadonlyMap<string, TreeEntry>>;
  readonly cache: SnapshotCache | undefined;
  readonly objectFormat: ObjectFormat;
  /** Where the private (0700) staging directory is created. */
  readonly tmpDir: string;
  readonly maxFileBytes: number;
  /** Root entry names never walked (the store directory). */
  readonly skipRootEntries: ReadonlySet<string>;
  /** Snapshot policy hook: return false to leave a path (and, for a directory, everything under it) out. */
  readonly include?: ((relPath: string) => boolean) | undefined;
  readonly nowNs: () => bigint;
}

export interface Snapshot {
  readonly stagingDir: string;
  /** The delta for storage; undefined for a full build (stagingDir then holds the whole tree). */
  readonly changes: WorkspaceChanges | undefined;
  /** The resulting tree with stats: the next cache once the checkpoint commit exists. */
  readonly files: Map<string, SnapshotFile>;
  readonly skipped: SkippedFile[];
  /** Files whose content was read in this pass. */
  readonly hashed: number;
  /** Files (or symlink targets) in which Redaction replaced something. */
  readonly redactedFiles: number;
  cleanup(): Promise<void>;
}

const DOT_GIT_ANY_CASE = /^\.git$/i;

/** The git blob id of `bytes` in a repository of `format`. */
export function gitBlobId(bytes: Uint8Array, format: ObjectFormat): string {
  return createHash(format).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/** Redact `raw` (file content or a symlink target). Returns `raw` itself when nothing was found. */
export function redactContent(raw: Buffer): { bytes: Buffer; hits: number } {
  if (raw.byteLength <= TEXT_SANITIZE_MAX_BYTES && isUtf8(raw)) {
    const { output, hits } = sanitize(raw.toString('utf8'));
    return hits.length === 0 ? { bytes: raw, hits: 0 } : { bytes: Buffer.from(output, 'utf8'), hits: hits.length };
  }
  const hits = scanBytes(raw);
  if (hits.length === 0) return { bytes: raw, hits: 0 };
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const hit of [...hits].sort((a, b) => a.offset - b.offset)) {
    const end = hit.offset + hit.length;
    if (end <= cursor) continue;
    parts.push(raw.subarray(cursor, Math.max(cursor, hit.offset)), Buffer.from(redactionMarker(hit.kind), 'utf8'));
    cursor = end;
  }
  parts.push(raw.subarray(cursor));
  return { bytes: Buffer.concat(parts), hits: hits.length };
}

interface WorkspaceFile {
  readonly rel: string;
  readonly abs: string;
  readonly mode: TreeMode;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ino: bigint;
}

async function listWorkspace(root: string, options: SnapshotOptions): Promise<{ files: WorkspaceFile[]; skipped: SkippedFile[] }> {
  const files: WorkspaceFile[] = [];
  const skipped: SkippedFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      const code = errnoCode(err);
      if (prefix !== '' && (code === 'ENOENT' || code === 'ENOTDIR')) return; // vanished while walking
      throw err;
    }
    names.sort();
    for (const name of names) {
      if (DOT_GIT_ANY_CASE.test(name)) continue;
      if (prefix === '' && options.skipRootEntries.has(name)) continue;
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (isExcludedPath(rel)) continue;
      if (options.include !== undefined && !options.include(rel)) continue;
      const abs = path.join(dir, name);
      let st: BigIntStats;
      try {
        st = await lstat(abs, { bigint: true });
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw err;
        // readdir decodes names as UTF-8; a name that is not valid UTF-8 comes back altered and cannot be read.
        if (name.includes('�')) skipped.push({ path: rel, size: null, reason: 'unreadable_name' });
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      const isLink = st.isSymbolicLink();
      if (!isLink && !st.isFile()) continue; // sockets, fifos, devices
      const size = Number(st.size);
      if (!isLink && size > options.maxFileBytes) {
        skipped.push({ path: rel, size, reason: 'too_large' });
        continue;
      }
      const mode: TreeMode = isLink ? '120000' : (st.mode & 0o111n) !== 0n ? '100755' : '100644';
      files.push({ rel, abs, mode, size, mtimeNs: st.mtimeNs, ino: st.ino });
    }
  };
  await walk(root, '');
  return { files, skipped };
}

async function stageEntry(root: string, rel: string, mode: TreeMode, bytes: Buffer): Promise<void> {
  const target = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (mode === '120000') {
    await symlink(bytes, target);
    return;
  }
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  if (mode === '100755') await chmod(target, 0o700);
}

/** Build the sanitized staging tree for one checkpoint of `workspaceDir`. The caller must call `cleanup()`. */
export async function buildSnapshot(options: SnapshotOptions): Promise<Snapshot> {
  const { files: current, skipped } = await listWorkspace(options.workspaceDir, options);
  const stagingDir = await mkdtemp(path.join(options.tmpDir, 'ckpt-stage-'));
  const cleanup = (): Promise<void> => rm(stagingDir, { recursive: true, force: true });
  try {
    const parentCommit = options.parentCommit;
    const cached =
      parentCommit !== null && options.cache?.workspaceDir === options.workspaceDir && options.cache.baseCommit === parentCommit
        ? options.cache.files
        : undefined;
    const parentTree: ReadonlyMap<string, TreeEntry> = parentCommit === null ? new Map() : (cached ?? (await options.readTree(parentCommit)));

    const files = new Map<string, SnapshotFile>();
    const written: string[] = [];
    let hashed = 0;
    let redactedFiles = 0;
    for (const file of current) {
      const known = cached?.get(file.rel);
      if (
        known !== undefined &&
        known.mode === file.mode &&
        known.size === file.size &&
        known.mtimeNs === file.mtimeNs &&
        known.ino === file.ino &&
        file.mtimeNs + RACY_WINDOW_NS < known.hashedAtNs
      ) {
        files.set(file.rel, known);
        continue;
      }

      const hashedAtNs = options.nowNs();
      let raw: Buffer;
      try {
        raw = file.mode === '120000' ? await readlink(file.abs, { encoding: 'buffer' }) : await readFile(file.abs);
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') continue; // vanished since listing: absent from this checkpoint
        throw err;
      }
      hashed += 1;
      const { bytes, hits } = redactContent(raw);
      if (hits > 0) redactedFiles += 1;
      const oid = gitBlobId(bytes, options.objectFormat);
      files.set(file.rel, { mode: file.mode, oid, size: file.size, mtimeNs: file.mtimeNs, ino: file.ino, hashedAtNs });

      const parent = parentTree.get(file.rel);
      if (parentCommit === null || parent === undefined || parent.mode !== file.mode || parent.oid !== oid) {
        await stageEntry(stagingDir, file.rel, file.mode, bytes);
        written.push(file.rel);
      }
    }

    const changes = parentCommit === null ? undefined : { written, deleted: [...parentTree.keys()].filter((p) => !files.has(p)) };
    return { stagingDir, changes, files, skipped, hashed, redactedFiles, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
