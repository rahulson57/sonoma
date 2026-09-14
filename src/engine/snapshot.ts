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
 * valid UTF-8 up to 64 MB is text and `sanitize()` redacts it in place. Anything else (non-UTF-8, or over the text
 * limit) goes through the byte-exact windowed `scanBytes()`. A clean one is committed byte-identical. One with ANY
 * secret hit is SKIPPED (SPEC-003 / SPEC-006, DEC-037, SPEC-015 amendment 6): it is left out of the checkpoint tree
 * and reported once for a `workspace.file_skipped` event, never redacted in place.
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
// S02 internal, used ONLY inside redactContent() (DEC-026 scanner, DEC-037 skip rule).
import { scanBytes } from '../redact/bundle.js';
import { isExcludedPath, sanitize } from '../redact/index.js';
import { RACY_WINDOW_NS } from '../storage/change-detection.js';
import { errnoCode } from '../storage/fs-util.js';
import type { WorkspaceChanges } from '../storage/types.js';
import type { CheckpointPhase } from './engine.js';

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
  /** `secret_detected`: non-UTF-8 (or over-limit) content in which the byte scanner found a secret (DEC-037). */
  readonly reason: 'too_large' | 'unreadable_name' | 'secret_detected';
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
  /**
   * Observe-only phase timings (SPEC-002 "Measurement definition"). Each `buildSnapshot` call reports changeDetection,
   * scanRedact, hash and blobWrite once, each the sum of its intervals in this call. Reading file content, creating
   * and removing the staging directory are not attributed to any phase. Unset: nothing is timed or reported.
   */
  readonly phaseTimer?: { add(phase: CheckpointPhase, ms: number): void } | undefined;
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
  /** Text files (or symlink targets) in which Redaction replaced something. Skipped files are in `skipped`. */
  readonly redactedFiles: number;
  cleanup(): Promise<void>;
}

const DOT_GIT_ANY_CASE = /^\.git$/i;

/** The git blob id of `bytes` in a repository of `format`. */
export function gitBlobId(bytes: Uint8Array, format: ObjectFormat): string {
  return createHash(format).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/**
 * Redact `raw` (file content or a symlink target) for the staging tree.
 *
 * - Valid UTF-8 up to TEXT_SANITIZE_MAX_BYTES is text: `sanitize()` redacts it in place. Returns `raw` itself when
 *   nothing was found.
 * - Anything else (non-UTF-8, or over the text limit) is byte-scanned with S02's reviewed windowed scanner. A clean
 *   one returns `raw` unchanged, so it is committed byte-identical. One with ANY hit returns `bytes: null`: the
 *   caller leaves the file out of the tree and reports it as `workspace.file_skipped` (DEC-037, which supersedes
 *   the in-place binary redaction of DEC-026). Rewriting bytes inside a binary yields a corrupt artifact that still
 *   looks valid, which is worse than an honest, auditable omission.
 *
 * `scanBytes` is an S02 internal, not part of the public src/redact/index.ts contract, so its use is confined to
 * this one function.
 */
export function redactContent(raw: Buffer): { bytes: Buffer | null; hits: number } {
  if (raw.byteLength <= TEXT_SANITIZE_MAX_BYTES && isUtf8(raw)) {
    const { output, hits } = sanitize(raw.toString('utf8'));
    return hits.length === 0 ? { bytes: raw, hits: 0 } : { bytes: Buffer.from(output, 'utf8'), hits: hits.length };
  }
  const hits = scanBytes(raw).length;
  return hits === 0 ? { bytes: raw, hits: 0 } : { bytes: null, hits };
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

/**
 * Hand one phase's accumulated time to the caller's timer. The timer only observes: if `add()` throws (or is not a
 * function), the error is caught and ignored HERE, so the snapshot is exactly what it would have been without a timer.
 */
function reportPhase(timer: { add(phase: CheckpointPhase, ms: number): void }, phase: CheckpointPhase, ms: number): void {
  try {
    timer.add(phase, ms);
  } catch {
    // ignored by design: a phase timer never changes a checkpoint's control flow or result
  }
}

/** The phases `buildSnapshot` times, in the order they are reported. Storage times the other three. */
type SnapshotPhase = Extract<CheckpointPhase, 'changeDetection' | 'scanRedact' | 'hash' | 'blobWrite'>;
const SNAPSHOT_PHASES: readonly SnapshotPhase[] = ['changeDetection', 'scanRedact', 'hash', 'blobWrite'];

/**
 * `buildSnapshot`'s phase clock. `start()` opens an interval; `lap(phase)` adds the time since the interval opened to
 * `phase` and opens the next interval at that same instant; `flush()` reports every phase's total once, in
 * SNAPSHOT_PHASES order. Time between a `lap()` and the next `start()` is attributed to no phase. Intervals never
 * overlap, so the reported sum never exceeds the wall time of the `buildSnapshot` call.
 */
interface PhaseStopwatch {
  start(): void;
  lap(phase: SnapshotPhase): void;
  flush(): void;
}

const doNothing = (): void => undefined;

/** The stopwatch when no phaseTimer is set: no clock read, no allocation, nothing reported. */
const NO_STOPWATCH: PhaseStopwatch = { start: doNothing, lap: doNothing, flush: doNothing };

class TimedStopwatch implements PhaseStopwatch {
  readonly #timer: NonNullable<SnapshotOptions['phaseTimer']>;
  readonly #totals: Record<SnapshotPhase, number> = { changeDetection: 0, scanRedact: 0, hash: 0, blobWrite: 0 };
  #mark = 0;

  constructor(timer: NonNullable<SnapshotOptions['phaseTimer']>) {
    this.#timer = timer;
  }

  start(): void {
    this.#mark = performance.now();
  }

  lap(phase: SnapshotPhase): void {
    const now = performance.now();
    this.#totals[phase] += now - this.#mark;
    this.#mark = now;
  }

  flush(): void {
    for (const phase of SNAPSHOT_PHASES) reportPhase(this.#timer, phase, this.#totals[phase]);
  }
}

function stopwatchFor(timer: SnapshotOptions['phaseTimer']): PhaseStopwatch {
  return timer === undefined ? NO_STOPWATCH : new TimedStopwatch(timer);
}

/**
 * Whether the stat cache's entry can stand in for `file` without reading it: the same mode, size, mtime and inode, and
 * an mtime outside RACY_WINDOW_NS of the moment the cached entry was hashed.
 */
function isStatCacheHit(known: SnapshotFile | undefined, file: WorkspaceFile): known is SnapshotFile {
  return (
    known !== undefined &&
    known.mode === file.mode &&
    known.size === file.size &&
    known.mtimeNs === file.mtimeNs &&
    known.ino === file.ino &&
    file.mtimeNs + RACY_WINDOW_NS < known.hashedAtNs
  );
}

/** Build the sanitized staging tree for one checkpoint of `workspaceDir`. The caller must call `cleanup()`. */
export async function buildSnapshot(options: SnapshotOptions): Promise<Snapshot> {
  // Phase timing (SPEC-002). Without a timer the stopwatch is NO_STOPWATCH, so performance.now() is never called and
  // nothing is reported.
  const watch = stopwatchFor(options.phaseTimer);
  watch.start();

  // changeDetection: walking the workspace and stat-ing every entry.
  const { files: current, skipped } = await listWorkspace(options.workspaceDir, options);
  watch.lap('changeDetection');
  const stagingDir = await mkdtemp(path.join(options.tmpDir, 'ckpt-stage-'));
  const cleanup = (): Promise<void> => rm(stagingDir, { recursive: true, force: true });
  try {
    // changeDetection: the tree this checkpoint is compared against (the stat cache, or the parent commit's tree).
    watch.start();
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
    watch.lap('changeDetection');
    for (const file of current) {
      // changeDetection: the stat-cache check.
      watch.start();
      const known = cached?.get(file.rel);
      if (isStatCacheHit(known, file)) {
        files.set(file.rel, known);
        watch.lap('changeDetection');
        continue;
      }
      watch.lap('changeDetection');

      // Reading the content is not attributed to any phase.
      const hashedAtNs = options.nowNs();
      let raw: Buffer;
      try {
        raw = file.mode === '120000' ? await readlink(file.abs, { encoding: 'buffer' }) : await readFile(file.abs);
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') continue; // vanished since listing: absent from this checkpoint
        throw err;
      }
      hashed += 1;
      // scanRedact: Redaction of the content.
      watch.start();
      const { bytes, hits } = redactContent(raw);
      watch.lap('scanRedact');
      if (bytes === null) {
        // Absent from this checkpoint's tree (and so deleted from the parent's, if it was there), reported once.
        skipped.push({ path: file.rel, size: file.size, reason: 'secret_detected' });
        continue;
      }
      if (hits > 0) redactedFiles += 1;
      // hash: the git blob id of the sanitized content.
      const oid = gitBlobId(bytes, options.objectFormat);
      watch.lap('hash');
      files.set(file.rel, { mode: file.mode, oid, size: file.size, mtimeNs: file.mtimeNs, ino: file.ino, hashedAtNs });

      // changeDetection: whether the sanitized blob differs from the parent tree. blobWrite: staging it when it does.
      const parent = parentTree.get(file.rel);
      const changed = parentCommit === null || parent === undefined || parent.mode !== file.mode || parent.oid !== oid;
      watch.lap('changeDetection');
      if (changed) {
        await stageEntry(stagingDir, file.rel, file.mode, bytes);
        written.push(file.rel);
        watch.lap('blobWrite');
      }
    }

    // changeDetection: the parent tree's paths that are gone.
    watch.start();
    const changes = parentCommit === null ? undefined : { written, deleted: [...parentTree.keys()].filter((p) => !files.has(p)) };
    watch.lap('changeDetection');
    watch.flush();
    return { stagingDir, changes, files, skipped, hashed, redactedFiles, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
