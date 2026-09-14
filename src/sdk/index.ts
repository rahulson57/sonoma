/** State SDK (SPEC-010) public surface. */
export { createCkpt, type Ckpt, type CkptOptions, type DeclaredStateEngine } from './ckpt.js';
export { CkptValidationError, isCkptValidationError } from './errors.js';
export { MAX_DECLARED_LIST_ENTRIES, MAX_DECLARED_STRING_BYTES, type DeclaredStateInput, type SaveOptions } from './validate.js';
export type { CheckpointRef } from '../engine/index.js';
