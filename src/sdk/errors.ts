/** Errors raised by the State SDK (SPEC-010). */

/**
 * A `save()` input broke a SPEC-010 limit. `field` names the offending DeclaredStateInput member (or `state`
 * for the object as a whole, `label` for the option). For a list entry, `index` is its position. Raised before
 * anything is sent to the Checkpoint Engine.
 */
export class CkptValidationError extends Error {
  override readonly name = 'CkptValidationError';
  readonly field: string;
  readonly index: number | undefined;

  constructor(field: string, message: string, index?: number) {
    super(`${index === undefined ? field : `${field}[${index}]`}: ${message}`);
    this.field = field;
    this.index = index;
  }
}

export function isCkptValidationError(err: unknown): err is CkptValidationError {
  return err instanceof CkptValidationError;
}
