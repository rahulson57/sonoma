/**
 * On-disk layout of the local store (SPEC-005):
 *
 *   <repo>/.ckpt/
 *     checkpoint.db        SQLite (WAL) index — rebuildable, not a source of truth
 *     objects/sha256/<2>/<hash>   CAS blobs — source of truth
 *     runs/<run_id>/run.json      run record — source of truth
 *     runs/<run_id>/events.jsonl  append-only execution ledger — source of truth
 *     lock/<run_id>.lock          single-writer lockfile
 *     tmp/                        same-filesystem staging for atomic renames and temporary git indexes
 *
 * Ids are validated before they become path segments, so no caller-supplied id can escape the store.
 */
import path from 'node:path';
import { StorageError } from './errors.js';
import { ensureDir } from './fs-util.js';

export const STORE_DIR_NAME = '.ckpt';

/** SPEC-004 `run_<ulid>` (Crockford base32, upper case). */
export const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
/** SPEC-004 `c_<n>`, n >= 1. */
export const CHECKPOINT_ID_PATTERN = /^c_[1-9][0-9]*$/;

export interface StoreLayout {
  readonly root: string;
  readonly db: string;
  readonly objects: string;
  readonly runs: string;
  readonly lock: string;
  readonly tmp: string;
}

export interface RunPaths {
  readonly dir: string;
  readonly runFile: string;
  readonly events: string;
}

export function storeLayout(repoDir: string): StoreLayout {
  const root = path.join(repoDir, STORE_DIR_NAME);
  return {
    root,
    db: path.join(root, 'checkpoint.db'),
    objects: path.join(root, 'objects', 'sha256'),
    runs: path.join(root, 'runs'),
    lock: path.join(root, 'lock'),
    tmp: path.join(root, 'tmp'),
  };
}

export async function ensureLayout(layout: StoreLayout): Promise<void> {
  for (const dir of [layout.root, path.dirname(layout.objects), layout.objects, layout.runs, layout.lock, layout.tmp]) {
    await ensureDir(dir);
  }
}

export function assertRunId(value: unknown, what = 'run_id'): asserts value is string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new StorageError('ERR_INVALID_INPUT', `${what} must match run_<ulid>, got ${JSON.stringify(value)}`);
  }
}

export function assertCheckpointId(value: unknown, what = 'checkpoint_id'): asserts value is string {
  if (typeof value !== 'string' || !CHECKPOINT_ID_PATTERN.test(value)) {
    throw new StorageError('ERR_INVALID_INPUT', `${what} must match c_<n>, got ${JSON.stringify(value)}`);
  }
}

export function runPaths(layout: StoreLayout, runId: string): RunPaths {
  assertRunId(runId);
  const dir = path.join(layout.runs, runId);
  return { dir, runFile: path.join(dir, 'run.json'), events: path.join(dir, 'events.jsonl') };
}

/** `c_12` → 12. */
export function checkpointNumber(checkpointId: string): number {
  assertCheckpointId(checkpointId);
  return Number(checkpointId.slice(2));
}

export function checkpointRefName(runId: string, checkpointId: string): string {
  assertRunId(runId);
  assertCheckpointId(checkpointId);
  return `refs/checkpoints/${runId}/${checkpointId}`;
}
