/** Context Builder public surface (SPEC-008). */
export { createContextBuilder } from './builder.js';
export { latestProjectionClaims } from './claims.js';
export { ContextError, isContextError, type ContextErrorCode } from './errors.js';
export { hydrateEvent, normalizeJson, tokensForChars } from './budget.js';
export { HISTORY_PAGE_SIZE, restoreTarget, scanRelevantHistory, type HistoryQuery, type RelevantHistory } from './history.js';
export {
  IN_PROGRESS_NOTICE,
  TIER1_RESOLVED_SHARE,
  intentLine,
  narrowStateIntents,
  renderedStatus,
  selectTier1Intents,
  type RenderedStatus,
  type Tier1Intents,
} from './intents.js';
export { CLAIM_SECTIONS, renderPreamble, type PreambleInput } from './preamble.js';
export {
  CHARS_PER_TOKEN,
  DEFAULT_MAX_TOKENS,
  INLINE_PAYLOAD_MAX_BYTES,
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
