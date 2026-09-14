import type { ProviderUsage } from './types.js';

export type DistillErrorCode =
  /** The run has spentUsd >= capUsd. Raised before the provider is called. */
  | 'DISTILL_BUDGET_EXCEEDED'
  /** A malformed request, budget or provider. Raised before the provider is called. */
  | 'DISTILL_INVALID_REQUEST'
  /** The request does not describe the checkpoint the store holds (state hash, commit or cursor differ). */
  | 'DISTILL_INPUT_MISMATCH'
  /** The provider's reply is not `{"claims": [...]}` or its usage is malformed. */
  | 'DISTILL_INVALID_OUTPUT'
  /** A projection that does not validate against schema/semantic-projection.schema.json. */
  | 'DISTILL_INVALID_PROJECTION'
  /** A projection id that is already stored: projections are never overwritten. */
  | 'DISTILL_PROJECTION_EXISTS'
  | 'DISTILL_PROJECTION_NOT_FOUND';

export class DistillError extends Error {
  override readonly name = 'DistillError';
  readonly code: DistillErrorCode;
  /** Set when the provider had already been called, so the caller can still charge the run's budget. */
  readonly usage: ProviderUsage | undefined;

  constructor(code: DistillErrorCode, message: string, options: { usage?: ProviderUsage; cause?: unknown } = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.usage = options.usage;
  }
}

export function isDistillError(err: unknown, code?: DistillErrorCode): err is DistillError {
  return err instanceof DistillError && (code === undefined || err.code === code);
}
