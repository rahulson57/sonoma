/**
 * Redaction — public contract (SPEC-003 "Public contract (`src/redact/index.ts`)").
 *
 * Every capture (tool request, stdout, stderr, env, workspace path) goes through these functions
 * BEFORE it is hashed or persisted. Redaction is a defense layer, not a guarantee: the store stays
 * potentially secret-bearing.
 */
export type { RedactionHit } from './sanitize.js';
export { sanitize } from './sanitize.js';
export type { EnvClassification, EnvEntry } from './env.js';
export { classifyEnv } from './env.js';
export { isExcludedPath } from './paths.js';
export { scanBundle } from './bundle.js';
