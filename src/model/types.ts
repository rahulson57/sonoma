/**
 * Canonical checkpoint model — SPEC-004 (TypeScript types).
 *
 * Every ingestion path (Claude Code adapter, SDK, future adapters) writes into these shapes; no
 * adapter defines its own. Field names follow SPEC-004 (snake_case), except SemanticProjection,
 * which follows SPEC-007 verbatim. The runtime contract is `schema/*.json`;
 * tests/unit/model/schema.test.ts asserts that the enum constants below equal the schema enums.
 *
 * Deterministic vs semantic is a hard split: Checkpoint, LedgerEvent, SideEffect, PendingIntent and
 * AgentStateObject are authoritative; SemanticClaim / SemanticProjection are derived interpretation
 * and can only name SEMANTIC_FIELDS.
 */
import type { LedgerActor, LedgerEventType } from '../ledger/event-types.js';

export type { LedgerActor, LedgerEventType };

export const CURRENT_SCHEMA_VERSION = 1;

/** Versions this build can read. Anything else is rejected, never guessed at. */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = [CURRENT_SCHEMA_VERSION];

/** Immutable content-addressed blob: sha256 of its bytes and its byte length. */
export interface BlobRef {
  readonly sha256: string;
  readonly size: number;
}

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** SPEC-004 Run. Persisted by Local Storage; the shape is canonical here. */
export interface Run {
  /** `run_<ulid>` */
  readonly run_id: string;
  /** Set on fork. */
  readonly parent_run_id: string | null;
  /** Set on fork. */
  readonly forked_from_checkpoint: string | null;
  /** `claude-code` · `sdk` · … */
  readonly agent: string;
  readonly created_at: string;
}

/** SPEC-004 Checkpoint = state + workspace commit + ledger cursor. */
export interface Checkpoint {
  readonly schemaVersion: number;
  /** `c_<n>`, monotonic per run. */
  readonly checkpoint_id: string;
  readonly run_id: string;
  readonly parent_checkpoint_id: string | null;
  /** Labelled checkpoints trigger distillation. */
  readonly label: string | null;
  /** The deterministic Agent State Object blob. */
  readonly state_blob: BlobRef;
  /** sha256 of the state blob; always equal to `state_blob.sha256`. */
  readonly state_hash: string;
  /** Git commit on `refs/checkpoints/<run>/<checkpoint>`. */
  readonly workspace_commit: string;
  /** Cursor: seq of the last ledger event included. */
  readonly ledger_seq: number;
  readonly usage: TokenUsage;
  readonly created_at: string;
}

/** A JSON object payload. Must survive a JSON round-trip (see canonicalJSON). */
export type JsonPayload = Readonly<Record<string, unknown>>;

/**
 * What callers append (SPEC-004 "Accepts: event drafts {run_id, type, actor, payload}").
 * The payload must already be sanitized (SPEC-003): the ledger hashes and stores it verbatim.
 */
export interface LedgerEventDraft {
  readonly run_id: string;
  readonly type: LedgerEventType;
  readonly actor: LedgerActor;
  /** SPEC-004 `intent_id?`: correlates a request with its acknowledgement. Absent means null. */
  readonly intent_id?: string | null | undefined;
  readonly payload: JsonPayload;
}

/** A sealed ledger event. Immutable once appended. */
export interface LedgerEvent {
  readonly event_id: string;
  readonly run_id: string;
  /** Strictly increasing and contiguous per run, starting at 1. */
  readonly seq: number;
  /** ISO-8601 UTC, from the ledger's injected clock. */
  readonly ts: string;
  readonly type: LedgerEventType;
  readonly actor: LedgerActor;
  /**
   * SPEC-015 amendment 2: top-level and part of the hashed event, so a request still correlates with an
   * acknowledgement whose payload was offloaded. Every event appended since the amendment carries it
   * (string or null). An event sealed before the amendment has no such member at runtime, and it is never
   * re-hashed to add one. Read it as `event.intent_id ?? null`.
   */
  readonly intent_id: string | null;
  /** Inline payload, or null when it was over the inline limit and stored as `payload_ref`. */
  readonly payload: JsonPayload | null;
  /** CAS blob holding the canonical JSON bytes of an over-limit payload; otherwise null. */
  readonly payload_ref: BlobRef | null;
  readonly prev_hash: string;
  /** sha256(prev_hash ‖ canonicalJSON(event without hash)) */
  readonly hash: string;
}

/** The only fields a semantic claim may speak about. Deterministic fields are not in this list. */
export const SEMANTIC_FIELDS = [
  'goal',
  'plan',
  'decision',
  'assumption',
  'open_question',
  'next_action',
  'current_step',
  'current_state',
] as const;

export type SemanticField = (typeof SEMANTIC_FIELDS)[number];

export const CLAIM_ORIGINS = ['agent_declared', 'distilled', 'human'] as const;

export type ClaimOrigin = (typeof CLAIM_ORIGINS)[number];

/** Why ckpt believes a claim. At least one array must be non-empty. */
export interface ClaimProvenance {
  readonly event_ids: readonly string[];
  readonly artifact_refs: readonly string[];
  readonly workspace_paths: readonly string[];
  readonly checkpoint_ids: readonly string[];
}

export interface SemanticClaim {
  readonly field: SemanticField;
  readonly value: string;
  readonly origin: ClaimOrigin;
  /** 0..1 */
  readonly confidence?: number;
  readonly provenance: ClaimProvenance;
}

/** SPEC-015 amendment 3: who produced a projection. */
export const PROJECTION_SOURCES = ['distilled', 'declared'] as const;

export type ProjectionSource = (typeof PROJECTION_SOURCES)[number];

export interface ProjectionDistiller {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
}

export interface ProjectionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/**
 * SPEC-007 SemanticProjection (camelCase per SPEC-007), with SPEC-015 amendment 3 applied. `source: 'distilled'`
 * requires non-null `distiller` and `usage`. `source: 'declared'` (an SDK or human declaration) may leave both
 * null, so it never needs a faked distiller block.
 */
export interface SemanticProjection {
  readonly id: string;
  readonly checkpointId: string;
  readonly source: ProjectionSource;
  readonly distiller: ProjectionDistiller | null;
  readonly input: {
    readonly stateHash: string;
    /** [previous cursor (exclusive), this cursor (inclusive)] */
    readonly ledgerRange: readonly [number, number];
    readonly workspaceCommit: string;
  };
  readonly claims: readonly SemanticClaim[];
  readonly usage: ProjectionUsage | null;
  readonly createdAt: string;
}

export const REVERSIBILITY = ['reversible', 'compensatable', 'irreversible'] as const;

export type Reversibility = (typeof REVERSIBILITY)[number];

/** SPEC-004: a side effect without explicit reversibility is irreversible. */
export const DEFAULT_REVERSIBILITY: Reversibility = 'irreversible';

/** SPEC-004 SideEffect: recorded, never undone. */
export interface SideEffect {
  readonly type: string;
  readonly target: string;
  readonly request_hash: string;
  readonly response_hash: string;
  readonly reversibility: Reversibility;
}

/** A SideEffect as supplied by a caller; reversibility may be left out. */
export type SideEffectInput = Omit<SideEffect, 'reversibility'> & {
  readonly reversibility?: Reversibility | undefined;
};

export const INTENT_KINDS = ['tool', 'side_effect'] as const;

export type IntentKind = (typeof INTENT_KINDS)[number];

export const INTENT_STATUSES = ['completed', 'in_progress', 'pending'] as const;

export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** One requested action and what the ledger acknowledges about it (SPEC-004 resume rule). */
export interface PendingIntent {
  readonly kind: IntentKind;
  /** The request's top-level intent_id, else tool_call_id / side_effect_id from its payload; null when it has none. */
  readonly intent_id: string | null;
  readonly request_event_id: string;
  readonly status: IntentStatus;
  readonly requested_seq: number;
  /** seq of the acknowledging (completed) or failure (pending) event; null while in_progress. */
  readonly resolved_seq: number | null;
}

/** SPEC-004 deterministic Agent State Object (minimal v1 shape). */
export interface AgentStateObject {
  readonly schemaVersion: number;
  readonly run_id: string;
  readonly checkpoint_id: string;
  readonly ledger_seq: number;
  readonly workspace_commit: string;
  readonly pending_intent: readonly PendingIntent[];
  readonly usage: TokenUsage;
}
