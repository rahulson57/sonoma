/**
 * Checkpoint references (SPEC-006 "CheckpointRef = { runId, checkpointId } (CLI form run_x:c_17)").
 * The engine speaks SPEC-006's camelCase ref and converts to storage's snake_case ref at the boundary.
 */
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN } from '../storage/layout.js';
import type { CheckpointRef as StorageCheckpointRef } from '../storage/types.js';
import { EngineError } from './errors.js';
import type { CheckpointRef } from './types.js';

/** A git object id (sha1 or sha256 repositories). */
export const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const CLI_REF_PATTERN = /^(run_[0-9A-HJKMNP-TV-Z]{26}):(c_[1-9][0-9]*)$/;

export function assertRunId(value: unknown, what = 'runId'): asserts value is string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new EngineError('ERR_INVALID_INPUT', `${what} must match run_<ulid>, got ${JSON.stringify(value)}`);
  }
}

export function assertCheckpointRef(value: unknown, what = 'ref'): asserts value is CheckpointRef {
  if (typeof value !== 'object' || value === null) {
    throw new EngineError('ERR_INVALID_INPUT', `${what} must be {runId, checkpointId}`);
  }
  const { runId, checkpointId } = value as { runId?: unknown; checkpointId?: unknown };
  assertRunId(runId, `${what}.runId`);
  if (typeof checkpointId !== 'string' || !CHECKPOINT_ID_PATTERN.test(checkpointId)) {
    throw new EngineError('ERR_INVALID_INPUT', `${what}.checkpointId must match c_<n>, got ${JSON.stringify(checkpointId)}`);
  }
}

export function toStorageRef(ref: CheckpointRef, what = 'ref'): StorageCheckpointRef {
  assertCheckpointRef(ref, what);
  return { run_id: ref.runId, checkpoint_id: ref.checkpointId };
}

/** `run_x:c_17` → `{ runId: 'run_x', checkpointId: 'c_17' }`. */
export function parseCheckpointRef(text: string): CheckpointRef {
  const match = typeof text === 'string' ? CLI_REF_PATTERN.exec(text) : null;
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new EngineError('ERR_INVALID_INPUT', `a checkpoint ref is run_<ulid>:c_<n>, got ${JSON.stringify(text)}`);
  }
  return { runId: match[1], checkpointId: match[2] };
}

export function formatCheckpointRef(ref: CheckpointRef): string {
  assertCheckpointRef(ref);
  return `${ref.runId}:${ref.checkpointId}`;
}
