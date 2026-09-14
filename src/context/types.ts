/**
 * Context Builder contract types (SPEC-008), built to the interim rulings DEC-034, DEC-036 and DEC-040
 * (challenge 01a09da8 stays open for the SPEC-008 amendment).
 *
 * - Input (DEC-036(2)): the Checkpoint Engine's RestoredCheckpoint as landed ({checkpoint, state, worktreePath,
 *   pendingIntent}). SPEC-008's own names (workspacePath, ledgerCursor) are accepted too. The cursor is always
 *   checkpoint.ledger_seq; a ledgerCursor that disagrees is rejected. The rendered pending-intent list is the engine's
 *   pendingIntent when supplied, else state.pending_intent.
 * - Tier 1 semantics (DEC-036(1)): AgentStateObject carries no semantic fields, so goal, plan, decisions and the rest
 *   exist only as claims, read through an injected, read-only ClaimSource (DEC-040: never storage internals).
 * - Dependencies are injected and read-only: the builder is never handed a write method it could call.
 */
import type { NameStatus } from '../engine/types.js';
import type { AgentStateObject, Checkpoint, LedgerEvent, PendingIntent, SemanticClaim, SemanticProjection } from '../model/types.js';
import type { StorageBackend } from '../storage/types.js';

/** SPEC-008 `buildResumeContext` default. */
export const DEFAULT_MAX_TOKENS = 8000;

/** SPEC-008: tokenEstimate = chars / 4, rounded up. */
export const CHARS_PER_TOKEN = 4;

/** What the Checkpoint Engine hands over after `resume(ref)`. */
export interface RestoredCheckpointInput {
  readonly checkpoint: Checkpoint;
  readonly state: AgentStateObject;
  /** SPEC-008 name. Must equal `checkpoint.ledger_seq` when given. */
  readonly ledgerCursor?: number;
  /** SPEC-008 name for the restored workspace directory. */
  readonly workspacePath?: string;
  /** SPEC-006 / engine name for the same directory. */
  readonly worktreePath?: string;
  /** The engine's recomputed pending intent (DEC-025/031/032). Rendered in place of `state.pending_intent`. */
  readonly pendingIntent?: readonly PendingIntent[];
}

export interface ResumeOptions {
  /** Upper bound on `tokenEstimate`. Positive integer; default 8000. */
  readonly maxTokens?: number;
}

export interface TargetAgent {
  readonly harness: string;
  readonly model?: string;
}

/** SPEC-008 Returns. */
export interface ResumeContext {
  /** Rendered from Tier 1 + Tier 2. */
  readonly systemPreamble: string;
  /**
   * Tier 1: always included. The restored state with pending_intent replaced by exactly the intents the preamble
   * lists, in the rendered list's own order (DEC-034(3)). Every other member is unchanged, and it stays schema-valid.
   */
  readonly state: AgentStateObject;
  /** Tier 2: always included (git sha). */
  readonly workspaceCommit: string;
  /** Tier 3: selected events at or before the cursor on the checkpoint's lineage, never the full ledger. */
  readonly hydratedEvents: LedgerEvent[];
  /** ceil(canonicalJSON({systemPreamble, state, workspaceCommit, hydratedEvents}).length / 4) (DEC-036(4)). Never above maxTokens. */
  readonly tokenEstimate: number;
}

/** The only storage calls the builder makes. Both are reads. */
export type ContextStorage = Pick<StorageBackend, 'getEvents' | 'getCheckpoint'>;

/** Commit-to-commit diff (the engine's WorkspaceGit satisfies it). Touches no index or worktree. */
export interface ContextGit {
  diffNameStatus(a: string, b: string): Promise<readonly NameStatus[]>;
}

/** What a ClaimSource has recorded for exactly one checkpoint (its run_id and checkpoint_id). */
export interface CheckpointClaims {
  /** Semantic projections of this checkpoint, oldest first. Only the newest one's claims are used. */
  readonly projections: readonly SemanticProjection[];
  /** Claims the agent declared at this checkpoint (origin `agent_declared`), in declaration order. */
  readonly declared: readonly SemanticClaim[];
}

/**
 * Read-only source of the semantic claims recorded for ONE checkpoint (DEC-036(1)). It never walks lineage: the
 * builder does, nearest first (claims.ts). No durable implementation exists yet; S14 supplies one (DEC-040).
 * projectionStoreClaims() adapts the Distiller's ProjectionStore.
 */
export interface ClaimSource {
  claimsAt(checkpoint: Checkpoint): Promise<CheckpointClaims>;
}

export interface ContextBuilderDeps {
  readonly storage: ContextStorage;
  readonly git: ContextGit;
  readonly claims?: ClaimSource;
}

/** SPEC-008 Interfaces. */
export interface ContextBuilder {
  buildResumeContext(restored: RestoredCheckpointInput, options?: ResumeOptions): Promise<ResumeContext>;
  buildHandoffContext(restored: RestoredCheckpointInput, targetAgent: TargetAgent): Promise<ResumeContext>;
}
