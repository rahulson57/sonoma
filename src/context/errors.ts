/** Errors raised by the Context Builder (SPEC-008). `code` is the stable, machine-checkable part. */

export type ContextErrorCode =
  | 'ERR_INVALID_INPUT'
  /** Tier 1 + Tier 2 alone exceed maxTokens: they are always included, and the context may never exceed the budget. */
  | 'ERR_BUDGET'
  /** A dependency returned records that disagree with themselves or with the request. */
  | 'ERR_CORRUPT';

export class ContextError extends Error {
  override readonly name = 'ContextError';
  readonly code: ContextErrorCode;

  constructor(code: ContextErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}

export function isContextError(err: unknown, code?: ContextErrorCode): err is ContextError {
  return err instanceof ContextError && (code === undefined || err.code === code);
}
