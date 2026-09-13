/**
 * Distiller contract (SPEC-007). A distillation turns one checkpoint's state object plus the ledger
 * delta since the previous checkpoint into a NEW, versioned SemanticProjection. It is interpretation,
 * never fact: it never writes the ledger, the Agent State Object or a git ref.
 */
import type { AgentStateObject, BlobRef, SemanticProjection } from '../model/types.js';

/** Recorded on every projection. Bump it whenever the prompt changes meaning. */
export const PROMPT_VERSION = 'distill-v1';

/** SPEC-007 default provider. The concrete provider is injected; these name the default. */
export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** SPEC-007 `DistillBudget` default cap per run (config `distill.budgetUsd`). */
export const DEFAULT_BUDGET_USD = 0.25;

/**
 * The fields a distilled claim may speak about: SPEC-007's list, verbatim. It is narrower than the
 * model's SEMANTIC_FIELDS (no `current_step`), so a distilled claim can never name that field.
 */
export const DISTILLED_FIELDS = ['goal', 'plan', 'decision', 'assumption', 'current_state', 'open_question', 'next_action'] as const;

export type DistilledField = (typeof DISTILLED_FIELDS)[number];

/** SPEC-007 "Accepts". */
export interface DistillRequest {
  readonly checkpointId: string;
  /** sha256 of the Agent State Object blob. */
  readonly stateHash: string;
  /** Previous checkpoint cursor (exclusive) → this checkpoint's cursor (inclusive). */
  readonly ledgerRange: readonly [number, number];
  /** Git commit under refs/checkpoints/<run>/<checkpoint>. */
  readonly workspaceCommit: string;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** SPEC-007 pluggable provider. Tests use tests/helpers/providerStub.ts; nothing here does network I/O. */
export interface DistillerProvider {
  readonly name: string;
  readonly model: string;
  complete(prompt: string): Promise<{ text: string; usage: ProviderUsage }>;
}

/** SPEC-007 per-run budget. */
export interface DistillBudget {
  readonly runId: string;
  readonly capUsd: number;
  readonly spentUsd: number;
}

/**
 * The members of a ledger event the distiller reads. A sealed LedgerEvent satisfies it. `payload` is
 * null when the payload was offloaded to the CAS blob named by `payload_ref`.
 */
export interface DistillEvent {
  readonly event_id: string;
  readonly seq: number;
  readonly type: string;
  readonly actor: string;
  readonly ts?: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly payload_ref?: BlobRef | null;
}

/** Where a distillation reads its inputs from: one run of the store. See storageSource(). */
export interface DistillSource {
  readonly runId: string;
  /** The checkpoint's Agent State Object and the sha256 of its stored blob bytes. */
  readState(checkpointId: string): Promise<{ readonly stateHash: string; readonly state: AgentStateObject }>;
  /** Events with fromSeq <= seq <= toSeq. The distiller re-applies the bound, so extra events are ignored. */
  readEvents(range: { readonly fromSeq: number; readonly toSeq: number }): Promise<readonly DistillEvent[]>;
  /** Bytes of a CAS blob: an offloaded event payload, already sanitized before it was stored. */
  readBlob(ref: BlobRef): Promise<Uint8Array>;
  /** True when `checkpointId` is a checkpoint of this run in the store. */
  hasCheckpoint(checkpointId: string): Promise<boolean>;
}

export interface DistillResult {
  /** The persisted projection. */
  readonly projection: SemanticProjection;
  /**
   * Claims the provider returned that were dropped: empty provenance, evidence outside the inputs, or an
   * invalid shape. Reported beside the projection because the projection schema has no such member.
   */
  readonly rejectedClaims: number;
  /** The run's budget after charging this distillation's cost. The caller persists it. */
  readonly budget: DistillBudget;
}
