/**
 * Leak assertions shared by the redaction tests (not a test file: vitest collects `*.test.ts` only).
 */
import { createHash } from 'node:crypto';
import { expect } from 'vitest';

/**
 * Every form in which a raw secret could survive into sanitized output: verbatim, JSON-escaped
 * (a PEM inside a JSON tool request has `\n` escapes), or any substantial line of a multi-line
 * secret.
 */
export function secretFragments(value: string): string[] {
  const fragments = new Set<string>([value, JSON.stringify(value).slice(1, -1)]);
  for (const line of value.split('\n')) if (line.length >= 16) fragments.add(line);
  // A credentialed URL's secret is its password: it must not survive on its own either.
  const password = /:\/\/[^:/@]*:([^@]+)@/.exec(value)?.[1];
  if (password) fragments.add(password);
  return [...fragments];
}

/** Fails (without printing the secret) when any fragment of `value` is present in `output`. */
export function expectNoLeak(output: string, value: string, label: string): void {
  secretFragments(value).forEach((fragment, index) => {
    expect(output.includes(fragment), `${label}: raw secret fragment #${index} survived`).toBe(false);
  });
}

/** The fingerprint format SPEC-003 requires: `sha256:` + 64 hex digits of the value. */
export function sha256Fingerprint(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export const FINGERPRINT_FORMAT = /^sha256:[0-9a-f]{64}$/;
