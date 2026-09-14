/** Checkpoint Engine contract types (SPEC-006 "Contract"). */
// Type only (DEC-030): the Distiller owns DistillRequest; the engine never imports src/distill at runtime.
import type { DistillRequest } from '../distill/index.js';
import type { AgentStateObject, Checkpoint, PendingIntent, SideEffect } from '../model/types.js';

/** SPEC-006 `CheckpointRef = { runId: string; checkpointId: string }` (CLI form `run_x:c_17`). */
export interface CheckpointRef {
  readonly runId: string;
  readonly checkpointId: string;
}

export interface CheckpointOptions {
  /** A label makes the checkpoint a distillation trigger (fire-and-forget `distillRequest`). */
  readonly label?: string | null;
}

/** What `resume(ref)` hands back: `{checkpoint, state, worktreePath, pendingIntent}`. */
export interface RestoredCheckpoint {
  readonly checkpoint: Checkpoint;
  readonly state: AgentStateObject;
  /** The run's execution worktree, checked out at `checkpoint.workspace_commit`. */
  readonly worktreePath: string;
  /** Recomputed from ledger acknowledgements: an unacknowledged request is `in_progress`, never `completed`. */
  readonly pendingIntent: PendingIntent[];
}

export interface RollbackResult {
  readonly restored: Checkpoint;
  /** Side effects recorded after the restored checkpoint. They are warnings: ckpt never undoes them. */
  readonly warnings: SideEffect[];
}

/** RFC 6902 operations produced by the state diff. */
export type JsonPatchOperation =
  | { readonly op: 'add'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'replace'; readonly path: string; readonly value: unknown };

export type JsonPatch = JsonPatchOperation[];

/** One line of `git diff --name-status <a> <b>`. Renames and copies carry the source path in `oldPath`. */
export interface NameStatus {
  readonly status: string;
  readonly path: string;
  readonly oldPath?: string;
}

export interface CheckpointDiff {
  readonly state: JsonPatch;
  readonly workspace: NameStatus[];
  /**
   * Per side, `[exclusive start, cursor]` in that side's own run: the events that side holds beyond the
   * two checkpoints' common ancestor. A side whose run is not in the other side's lineage starts at 0.
   */
  readonly ledger: { readonly a: [number, number]; readonly b: [number, number] };
  /** Side effects recorded inside either ledger range (a's first, then b's). */
  readonly sideEffects: SideEffect[];
}

export interface ReplayOptions {
  /** Exact replay: the recorded events, hash chain verified; no model, tool or network is ever called. */
  readonly exact: boolean;
}

/**
 * Where distillation requests go (SPEC-006 `distillRequest`, DEC-006, DEC-030). The message is the Distiller's own
 * DistillRequest, equal to its distillRequestFor(checkpoint, parent). Checkpoint ids repeat across runs, so the run
 * travels as call context. The engine calls `request` only after `checkpoint()` has returned, never awaits it, and
 * ignores its failures: checkpointing never waits on a model.
 */
export interface DistillRequestPort {
  request(message: DistillRequest, context: { readonly runId: string }): void | Promise<void>;
}
