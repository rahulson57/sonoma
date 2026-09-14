/**
 * Context Builder contract types (SPEC-008).
 *
 * Resolutions of what SPEC-008 leaves open against the landed S03/S05/S06 code (challenge 01a09da8, Q-018):
 * - Input: the Checkpoint Engine's RestoredCheckpoint as landed ({checkpoint, state, worktreePath, pendingIntent})
 *   is accepted as is. SPEC-008's own names (workspacePath, ledgerCursor) are accepted too. ledgerCursor, when
 *   given, must equal checkpoint.ledger_seq.
 * - Tier 1 = pending intent (the engine's DEC-025/031/032 pendingIntent when supplied, else state.pending_intent)
 *   plus the semantic claims of an optional, read-only ClaimSource. AgentStateObject carries no semantic fields.
 * - Dependencies are injected and read-only: the builder is never handed a write method it could call.
 */
import type { NameStatus } from '../engine/types.js';
import type { AgentStateObject, Checkpoint, LedgerEvent, PendingIntent, SemanticClaim } from '../model/types.js';
import type { StorageBackend } from '../storage/types.js';

/** SPEC-008 `buildResumeContext` default. */
export const DEFAULT_MAX_TOKENS = 8000;

/** SPEC-008: tokenEstimate = chars / 4, rounded up. */
export const CHARS_PER_TOKEN = 4;

/** SPEC-008: a payload larger than 4 KB is referenced by sha256, not inlined. */
export const INLINE_PAYLOAD_MAX_BYTES = 4096;

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
   * Tier 1: always included. The checkpoint's state object, with pending_intent narrowed to the intents the preamble
   * lists (every unresolved and side-effect intent, resolved tool intents newest first within budget; intents.ts).
   */
  readonly state: AgentStateObject;
  /** Tier 2: always included (git sha). */
  readonly workspaceCommit: string;
  /** Tier 3: selected events at or before the cursor, never the full ledger. */
  readonly hydratedEvents: LedgerEvent[];
  /** ceil(JSON length of {systemPreamble, state, workspaceCommit, hydratedEvents} / 4). Never above maxTokens. */
  readonly tokenEstimate: number;
}

/** The only storage calls the builder makes. Both are reads. */
export type ContextStorage = Pick<StorageBackend, 'getEvents' | 'getCheckpoint'>;

/** Commit-to-commit diff (the engine's WorkspaceGit satisfies it). Touches no index or worktree. */
export interface ContextGit {
  diffNameStatus(a: string, b: string): Promise<readonly NameStatus[]>;
}

/** Read-only source of the semantic claims shown in Tier 1 for a checkpoint. */
export interface ClaimSource {
  claimsFor(checkpoint: Checkpoint): Promise<readonly SemanticClaim[]>;
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
