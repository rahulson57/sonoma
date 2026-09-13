/**
 * Env-name classification rules (SPEC-003 "Detection" and "Env capture", DEC-007).
 *
 * The spec's minimum name patterns are `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD` and
 * `*CREDENTIAL*`. The list below is a deliberate SUPERSET of them, matched case-insensitively
 * (over-classifying a variable as secret is the acceptable failure; missing one is not). The same
 * rules drive both `classifyEnv()` and the `NAME=value` assignment detector inside `sanitize()`,
 * so an env dump in tool stdout is judged exactly like a captured environment.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  // SPEC-003 minimum.
  /_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /CREDENTIAL/i,
  // Superset.
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /_PASS$/i,
  /_PWD$/i,
  /ACCESS_?KEY/i,
  /PRIVATE_?KEY/i,
  /API_?KEY/i,
  /^(KEY|TOKEN|PASS|AUTH)$/i,
];

/** Variables that keep their values in an env capture (SPEC-003 allowlist, exact names). */
export const SAFE_ENV_NAMES: ReadonlySet<string> = new Set(['PATH', 'HOME', 'NODE_ENV', 'LANG', 'CI']);

/** True when a variable (or config key) name marks its value as a secret. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}
