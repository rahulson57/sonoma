/** Local Storage (SPEC-005) public surface. */
export type {
  CheckpointRef,
  NewCheckpoint,
  NewLedgerEvent,
  NewRun,
  ProjectionQuery,
  ReindexCounts,
  StorageBackend,
  WorkspaceChanges,
} from './types.js';
export { LocalBackend, type LocalBackendOptions, type StorageFaults } from './local-backend.js';
export { StorageError, isStorageError, type StorageErrorCode } from './errors.js';
export { BlobStore, assertBlobRef } from './cas.js';
export { RunLock, isProcessAlive, runLockPath, type LockOwner, type RunLockOptions } from './lock.js';
export {
  ChangeDetector,
  RACY_WINDOW_NS,
  nodeChangeDetectionFs,
  type ChangeDetectionFs,
  type ChangeDetectionResult,
  type ChangeDetectorOptions,
  type DetectedFile,
  type FileCache,
  type FileCacheEntry,
  type FileChangeStatus,
  type FileStatInfo,
} from './change-detection.js';
export { IndexDb, type IndexCounts, type IndexedProjection, type ProjectionIndexEntry } from './index-db.js';
export { CHECKPOINT_IDENTITY, GitRepo, collectStagingTree, type CommitTreeOptions, type CommitTreeResult } from './git.js';
export { ulid, CROCKFORD_BASE32, type RandomSource } from './ids.js';
export {
  CHECKPOINT_ID_PATTERN,
  RUN_ID_PATTERN,
  STORE_DIR_NAME,
  checkpointRefName,
  storeLayout,
  type StoreLayout,
} from './layout.js';
