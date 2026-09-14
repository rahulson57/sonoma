/** Distiller (SPEC-007) public surface. */
export * from './types.js';
export { DistillError, isDistillError, type DistillErrorCode } from './errors.js';
export { assertBudgetAvailable, chargeBudget, createBudget } from './budget.js';
export { SECRET_NAMED_VALUE, buildPrompt, eventsInRange, redactJson, type PromptEvent, type PromptInput } from './prompt.js';
export { parseClaims, validateClaims, type ClaimValidation, type ParsedClaims, type ProvenanceContext } from './provenance.js';
export { BlobProjectionStore, type ProjectionBlobs, type ProjectionStore } from './projection-store.js';
export { storageSource, type DistillStorage } from './storage-source.js';
export { distill, type DistillDeps } from './distiller.js';
export { DISTILL_TRIGGERS, distillForTrigger, distillRequestFor, shouldDistill, type DistillTrigger } from './triggers.js';
