/** Local Read-Only Inspector (SPEC-012) contract types. */
import type { CheckpointDiff, CheckpointEngine } from '../engine/index.js';
import type { AgentStateObject, JsonPayload, LedgerActor, LedgerEventType, Run, SideEffect } from '../model/types.js';
import type { StorageBackend } from '../storage/types.js';

export type { CheckpointDiff };

/** SPEC-012 `startInspector({port = 7420, host = '127.0.0.1'})`. */
export const DEFAULT_PORT = 7420;
export const DEFAULT_HOST = '127.0.0.1';

/**
 * StorageBackend READ methods only. No write method (createRun, appendEvent, putBlob, createCheckpoint, fork,
 * reindex) is part of this type, so no inspector code can call one. `getBlob` is absent too: display never reads
 * CAS content.
 */
export type InspectorBackend = Pick<StorageBackend, 'getEvents' | 'getCheckpoint' | 'listCheckpoints' | 'getState'>;

/** `diff()` for /api/diff, and `repoRoot` for read-only commit-to-commit tree reads. No mutating operation. */
export type InspectorEngine = Pick<CheckpointEngine, 'diff' | 'repoRoot'>;

/**
 * Run listing. StorageBackend has no read method that lists runs (challenge 01a09daa on SPEC-012), so the
 * composition root passes one; `readRunRecords(backend.layout.runs)` is the read-only implementation.
 */
export type ListRuns = () => Promise<Run[]>;

export interface InspectorOptions {
  /** Default 7420. 0 picks a free port. */
  readonly port?: number;
  /** Default 127.0.0.1. */
  readonly host?: string;
  readonly backend: InspectorBackend;
  readonly engine: InspectorEngine;
  readonly listRuns: ListRuns;
}

export interface InspectorHandle {
  /** `http://127.0.0.1:7420/` with defaults. */
  readonly url: string;
  close(): Promise<void>;
}

/** Checkpoint ids are CLI refs `run_<ulid>:c_<n>`: `c_<n>` alone repeats across runs. */
export interface TimelineNode {
  checkpointId: string;
  /** Same-run parent, or for a fork's first checkpoint the checkpoint it was forked from; null for a root. */
  parentId: string | null;
  runId: string;
  label: string | null;
  /** ISO-8601 */
  createdAt: string;
  /** `[parent cursor (exclusive), this cursor (inclusive)]` */
  ledgerRange: [number, number];
}

/** SPEC-012 display policy: a payload not inlined, shown as its sha256 and size. */
export interface PayloadRef {
  /** `sha256:<hex>` */
  readonly ref: string;
  readonly size: number;
}

/** A ledger event as displayed: exactly one of `payload` / `payloadRef` is set (both null for an empty record). */
export interface InspectorEvent {
  readonly seq: number;
  readonly type: LedgerEventType;
  readonly actor: LedgerActor;
  readonly ts: string;
  readonly payload: JsonPayload | null;
  readonly payloadRef: PayloadRef | null;
}

/** GET /api/checkpoints/:id — the STATE, WORKSPACE and LEDGER panes. */
export interface CheckpointPanes {
  state: AgentStateObject;
  workspace: { commit: string; changedPaths: string[] };
  ledger: {
    range: [number, number];
    toolsUsed: string[];
    modelCalls: number;
    sideEffects: SideEffect[];
    /** The range's events under the display policy. */
    events: InspectorEvent[];
  };
}
