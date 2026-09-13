import { isSecretEnvName, SAFE_ENV_NAMES } from './envNames.js';
import { fingerprint } from './fingerprint.js';
import { sanitize } from './sanitize.js';

export type EnvClassification = 'secret' | 'safe' | 'unknown';

/** One captured environment variable (SPEC-003 "Env capture"). */
export interface EnvEntry {
  name: string;
  classification: EnvClassification;
  /** `null` for secrets; never a raw secret. */
  value: string | null;
  /** `sha256:<hex>` of the FULL original value, for every entry. */
  fingerprint: string;
}

/** SPEC-002 payload limit: longer env values are truncated; the fingerprint still covers the full value. */
export const MAX_ENV_VALUE_BYTES = 64 * 1024;

function truncateUtf8(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= MAX_ENV_VALUE_BYTES) return value;
  // A cut inside a multi-byte character decodes to U+FFFD; drop that partial character.
  return bytes.subarray(0, MAX_ENV_VALUE_BYTES).toString('utf8').replace(/�$/, '');
}

function classifyOne(name: string, value: string): EnvEntry {
  const valueFingerprint = fingerprint(value);
  const secret: EnvEntry = { name, classification: 'secret', value: null, fingerprint: valueFingerprint };

  // 1. Secret-named variables never keep a value, whatever it looks like.
  if (isSecretEnvName(name)) return secret;

  // Scan the full value before any truncation, so a secret straddling the limit is still seen.
  const scanned = sanitize(value);

  // 2. Allowlisted variables keep their value. Anything a detector flags inside it is still
  //    redacted in place, so the allowlist can never carry a secret into the store.
  if (SAFE_ENV_NAMES.has(name)) {
    return { name, classification: 'safe', value: truncateUtf8(scanned.output), fingerprint: valueFingerprint };
  }

  // 3. Any other variable is judged by its value: a detected secret nulls the whole value
  //    (e.g. a DATABASE_URL carrying a password).
  if (scanned.hits.length > 0) return secret;

  // 4. Unknown and clean: kept, because it passed the same scanner as every other capture.
  return { name, classification: 'unknown', value: truncateUtf8(value), fingerprint: valueFingerprint };
}

/**
 * Field-level classification of an environment capture. Entries are sorted by name, so the same
 * environment always yields the same (hashable) array, regardless of key insertion order.
 */
export function classifyEnv(env: Record<string, string>): EnvEntry[] {
  return Object.entries(env)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => classifyOne(name, String(value ?? '')));
}
