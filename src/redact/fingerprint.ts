import { createHash } from 'node:crypto';

/** Every fingerprint is self-describing: `sha256:` followed by 64 lowercase hex digits. */
export const FINGERPRINT_PREFIX = 'sha256:';

/**
 * sha256 fingerprint of a value (SPEC-003: secret env entries and redaction hits carry a sha256
 * fingerprint instead of the value). Strings are hashed as UTF-8.
 *
 * A fingerprint lets two captures be compared ("same token as before?") without storing the
 * token. It is not a secrecy guarantee for guessable values: a short password can be brute-forced
 * from its sha256, which is one reason the store stays "potentially secret-bearing" (DEC-007).
 */
export function fingerprint(value: string | Uint8Array): string {
  return FINGERPRINT_PREFIX + createHash('sha256').update(value).digest('hex');
}
