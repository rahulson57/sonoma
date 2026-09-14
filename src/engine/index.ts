/** Checkpoint Engine (SPEC-006) public surface. */
export { CheckpointEngine, ENGINE_OWNED_EVENT_TYPES, type CheckpointEngineOptions } from './engine.js';
export { EngineError, isEngineError, type EngineErrorCode } from './errors.js';
export { assertCheckpointRef, formatCheckpointRef, parseCheckpointRef, toStorageRef } from './refs.js';
export { LINEAGE_SCHEMAS, lineagePayload, type LineageEventType, type LineageFieldKind } from './lineage.js';
export { MAX_TOOL_OUTPUT_BYTES, sanitizePayload } from './observations.js';
export { NO_RESPONSE_HASH, deriveSideEffects } from './side-effects.js';
export { diffJson } from './json-patch.js';
export { PRESERVED_ON_RESTORE, WorkspaceGit } from './git.js';
export { MAX_SNAPSHOT_FILE_BYTES, TEXT_SANITIZE_MAX_BYTES, buildSnapshot, gitBlobId, redactContent } from './snapshot.js';
export type {
  CheckpointDiff,
  CheckpointOptions,
  CheckpointRef,
  DistillRequest,
  DistillRequestPort,
  JsonPatch,
  JsonPatchOperation,
  NameStatus,
  ReplayOptions,
  RestoredCheckpoint,
  RollbackResult,
} from './types.js';
