/**
 * The StorageBackend contract (SPEC-005). v1 ships only LocalBackend; the contract is shaped so a v2
 * RemoteBackend can implement it without changing callers.
 *
 * Input shapes SPEC-005 names but does not define are resolved here (reported in TASK-004's proposal):
 * - CheckpointRef names a checkpoint within its run.
 * - NewLedgerEvent is S03's draft without run_id. Storage seals it through S03's ExecutionLedger, so the
 *   hash chain has one implementation and storage never adds members to a sealed event.
 * - NewCheckpoint carries the caller-sanitized staging tree and the deterministic state inputs. Storage
 *   assigns checkpoint_id, builds the commit, and emits `checkpoint.created` itself, because that event
 *   records the workspace commit it produces.
 * - NewCheckpoint may carry `changes`, the delta from the parent tree, so storage reads only changed
 *   files (DEC-019(1)). Computing that delta is the caller's job; storage does not re-walk the workspace.
 */
import type { Readable } from 'node:stream';
import type {
  AgentStateObject,
  BlobRef,
  Checkpoint,
  LedgerEvent,
  LedgerEventDraft,
  PendingIntent,
  Run,
  TokenUsage,
} from '../model/types.js';

export interface NewRun {
  /** `claude-code` · `sdk` · … */
  readonly agent: string;
  /** Both or neither: set when the run is a fork. */
  readonly parent_run_id?: string | null;
  readonly forked_from_checkpoint?: string | null;
}

export type NewLedgerEvent = Omit<LedgerEventDraft, 'run_id'>;

export interface CheckpointRef {
  readonly run_id: string;
  readonly checkpoint_id: string;
}

/** A workspace delta from a parent tree (DEC-019(1)). Paths are repo-relative POSIX paths, as in the commit. */
export interface WorkspaceChanges {
  /** Files and symlinks added or modified (content, executable bit or link target); read from stagingDir. */
  readonly written: readonly string[];
  /** Files and symlinks of the parent tree that are gone. */
  readonly deleted: readonly string[];
}

export interface NewCheckpoint {
  readonly run_id: string;
  /** A checkpoint of the same run, or null (first checkpoint; a fork's first checkpoint). */
  readonly parent_checkpoint_id: string | null;
  readonly label?: string | null;
  /** Deterministic state inputs; storage fills run_id, checkpoint_id, ledger_seq and workspace_commit. */
  readonly pending_intent: readonly PendingIntent[];
  readonly usage: TokenUsage;
  /**
   * Directory holding the SANITIZED staging tree to commit (SPEC-003: path exclusion and redaction are
   * applied by the caller before this point). Storage commits exactly its regular files and symlinks.
   */
  readonly stagingDir: string;
  /**
   * Optional delta from the parent tree (DEC-019(1)). The parent tree is the `parent_checkpoint_id`
   * checkpoint's commit or, for a fork's first checkpoint, the source checkpoint's commit. When there is
   * one, storage builds on it and reads only `written` from stagingDir, so unchanged files are never
   * read. When there is none, `changes` is ignored and stagingDir is committed in full.
   *
   * A delta that does not fit fails with ERR_INVALID_CHANGES, and nothing is written. That covers a
   * `written` path missing from stagingDir, a `written` path that goes through a symlink (or any other
   * non-directory) in stagingDir, so it could not read bytes from outside the sanitized tree, a `deleted`
   * path that is not a file of the parent tree, a path in both lists, a path with a `.git` segment in any
   * letter case, and a file/directory clash with an entry the delta does not remove. A path git itself
   * refuses to index is never dropped silently: the checkpoint fails (ERR_INVALID_CHANGES here, and
   * ERR_INVALID_INPUT for a full build).
   */
  readonly changes?: WorkspaceChanges;
}

export interface StorageBackend {
  createRun(input: NewRun): Promise<Run>;
  appendEvent(runId: string, event: NewLedgerEvent): Promise<LedgerEvent>;
  getEvents(runId: string, range: { fromSeq: number; toSeq: number }): Promise<LedgerEvent[]>;
  /** sha256, dedup */
  putBlob(data: Uint8Array | Readable): Promise<BlobRef>;
  getBlob(ref: BlobRef): Promise<Readable>;
  /**
   * Single writer per run. Durably writes the checkpoint as ONE atomic unit, in visibility order:
   * state blob (CAS) → git ref → `checkpoint.created` ledger event → index row.
   *
   * Storage seals and appends `checkpoint.created` itself, through S03's ExecutionLedger, and the
   * returned Checkpoint's `ledger_seq` is that event's seq (DEC-018). Callers, including the Checkpoint
   * Engine, MUST NOT append a second `checkpoint.created`; `appendEvent` rejects that type.
   */
  createCheckpoint(cp: NewCheckpoint): Promise<Checkpoint>;
  getCheckpoint(id: CheckpointRef): Promise<Checkpoint>;
  listCheckpoints(runId: string): Promise<Checkpoint[]>;
  getState(id: CheckpointRef): Promise<AgentStateObject>;
  fork(id: CheckpointRef): Promise<Run>;
  reindex(): Promise<{ runs: number; checkpoints: number; events: number }>;
}
