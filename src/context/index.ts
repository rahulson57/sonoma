/** Context Builder public surface (SPEC-008; DEC-034, DEC-036, DEC-040). */
export { createContextBuilder } from './builder.js';
export { projectionStoreClaims, selectClaims, type ClaimSelection } from './claims.js';
export { ContextError, isContextError, type ContextErrorCode } from './errors.js';
export { canonicalChars, contextChars, hydrateEvent, normalizeJson, preambleLinesChars, tokensForChars, type ContextParts } from './budget.js';
export { HISTORY_PAGE_SIZE, lineageMark, scanRelevantHistory, type HistoryQuery, type RelevantHistory } from './history.js';
export {
  COMPLETED_TOOL_INTENT_CAP,
  IN_PROGRESS_NOTICE,
  PENDING_TOOL_INTENT_CAP,
  compareIntents,
  intentGroup,
  intentLine,
  renderedStatus,
  type IntentGroup,
  type RenderedStatus,
} from './intents.js';
export { LineageReader, checkpointKey } from './lineage.js';
export {
  CLAIM_SECTIONS,
  NO_SEMANTIC_STATE,
  claimLines,
  omittedClaimsLine,
  omittedIntentsLine,
  renderPreamble,
  reservedTier3DroppedLine,
  tier3DroppedLine,
  type PreambleInput,
  type Tier3DroppedCounts,
  type WorkspaceBase,
} from './preamble.js';
export { MANDATORY_CLAIM_FIELDS, mandatoryTier1, selectTier1, type Tier1Result, type Tier1Selection } from './tier1.js';
export {
  CHARS_PER_TOKEN,
  DEFAULT_MAX_TOKENS,
  type CheckpointClaims,
  type ClaimSource,
  type ContextBuilder,
  type ContextBuilderDeps,
  type ContextGit,
  type ContextStorage,
  type RestoredCheckpointInput,
  type ResumeContext,
  type ResumeOptions,
  type TargetAgent,
} from './types.js';
