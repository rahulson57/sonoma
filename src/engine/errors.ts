/** Errors raised by the Checkpoint Engine (SPEC-006). `code` is the stable, machine-checkable part. */

export type EngineErrorCode =
  | 'ERR_INVALID_INPUT'
  /** An observation used an event type only the engine or storage may append (lineage, checkpoint.created). */
  | 'ERR_RESERVED_EVENT'
  /** The run's workspace directory is missing or is not a ckpt execution worktree. */
  | 'ERR_WORKSPACE'
  | 'ERR_GIT'
  /** Durable records disagree with themselves (a gap in the ledger, a broken hash chain). */
  | 'ERR_CORRUPT';

export class EngineError extends Error {
  override readonly name = 'EngineError';
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}

export function isEngineError(err: unknown, code?: EngineErrorCode): err is EngineError {
  return err instanceof EngineError && (code === undefined || err.code === code);
}
