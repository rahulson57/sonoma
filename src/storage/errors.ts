/** Errors raised by Local Storage (SPEC-005). `code` is the stable, machine-checkable part. */

export type StorageErrorCode =
  /** A second writer tried to take a run another live writer holds (SPEC-005 single writer). */
  | 'ERR_RUN_LOCKED'
  | 'ERR_NOT_FOUND'
  | 'ERR_INVALID_INPUT'
  /** Durable artifacts disagree with themselves (broken chain, bad blob, unreadable record). */
  | 'ERR_CORRUPT'
  | 'ERR_GIT'
  /** SPEC-005 "must never store a blob larger than 1 MB inline in SQLite". */
  | 'ERR_INLINE_TOO_LARGE'
  | 'ERR_CLOSED';

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}

export function isStorageError(err: unknown, code?: StorageErrorCode): err is StorageError {
  return err instanceof StorageError && (code === undefined || err.code === code);
}
