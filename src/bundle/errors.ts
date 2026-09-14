/** Errors raised by Export/Import (SPEC-011). `code` is the stable, machine-checkable part. */

export type BundleErrorCode =
  | 'ERR_INVALID_INPUT'
  | 'ERR_NOT_FOUND'
  /** writeBundle called without `{confirmed: true}` (SPEC-011 "Must never" write before confirmation). */
  | 'ERR_NOT_CONFIRMED'
  /** An unsafe bundle without the exact `EXPORT UNSAFE` confirmation. */
  | 'ERR_UNSAFE_NOT_CONFIRMED'
  /** writeBundle given a manifest that did not come from this service's planExport (or was already used). */
  | 'ERR_UNKNOWN_PLAN'
  /** A checkpoint tree holds a path Redaction's isExcludedPath() excludes; nothing is written, even unsafe. */
  | 'ERR_EXCLUDED_PATH'
  /** The source store disagrees with itself (broken chain, missing blob, malformed record). */
  | 'ERR_CORRUPT_STORE'
  /** The output path already exists; a bundle never overwrites a file. */
  | 'ERR_OUTPUT_EXISTS'
  /** Not a well-formed bundle (bad tar, unknown entry, malformed manifest or record). */
  | 'ERR_INVALID_BUNDLE'
  /** A blob, git object, record or ledger line does not match its hash (or the hash chain is broken). */
  | 'ERR_TAMPERED'
  /** The bundle leaves out something import needs (ledger, refs, objects) and the store does not have it. */
  | 'ERR_INCOMPLETE_BUNDLE'
  /** The run already exists in the destination store with a different head. */
  | 'ERR_RUN_EXISTS'
  /** The bundle was imported, but the index could not be rebuilt afterwards. */
  | 'ERR_REINDEX'
  | 'ERR_GIT';

export class BundleError extends Error {
  override readonly name = 'BundleError';
  readonly code: BundleErrorCode;

  constructor(code: BundleErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}

export function isBundleError(err: unknown, code?: BundleErrorCode): err is BundleError {
  return err instanceof BundleError && (code === undefined || err.code === code);
}
