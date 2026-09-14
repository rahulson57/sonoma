/** Errors raised by the Context Builder (SPEC-008). `code` is the stable, machine-checkable part. */

export type ContextErrorCode =
  | 'ERR_INVALID_INPUT'
  /**
   * The smallest valid context exceeds maxTokens (DEC-034(5)): the never-dropped Tier 1 set (every in-progress
   * intent, every side-effect intent, the goal / current_step / next_action claims), Tier 2 and the rest of the
   * mandatory preamble. Everything else is dropped whole before this is raised.
   */
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

export function invalidInput(message: string): ContextError {
  return new ContextError('ERR_INVALID_INPUT', message);
}

export function corrupt(message: string): ContextError {
  return new ContextError('ERR_CORRUPT', message);
}
