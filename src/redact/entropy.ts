/**
 * High-entropy string detection (SPEC-003 "Detection": ... + high-entropy strings).
 *
 * Shannon entropy alone does not separate a short random token from a long identifier. Measured
 * over 20k samples, 32-char random alphanumerics bottom out near 3.9 bits/char, while camelCase
 * names and file paths sit at 3.8–4.4. So a candidate is judged on its entropy against a
 * length-scaled floor, set below the MINIMUM observed for random tokens of that length and
 * alphabet, AND on its character-class mix. That mix is what separates `x9Qf2...` from
 * `createCheckpointFromTree`.
 *
 * Bias, per SPEC-003: false positives are acceptable, false negatives are the failure. The
 * detection rate over random base64 / base64url / alphanumeric / hex / base32 tokens is pinned by
 * tests/unit/redact/sanitize.test.ts.
 */

/** Shortest run of token characters that is considered at all. */
export const HIGH_ENTROPY_MIN_LENGTH = 20;

/**
 * Source of the candidate-token pattern: runs of base64, base64url and hex characters, plus
 * trailing base64 padding. `=` is allowed only as that padding, so `NAME=value` is judged as a
 * name and a value, not as one glued token that would swallow the variable name.
 *
 * Written `x{20}x*` rather than `x{20,}`: V8 keeps backtracking state per iteration of a `{n,}`
 * loop and throws RangeError on a multi-megabyte run.
 */
export const HIGH_ENTROPY_TOKEN_SOURCE = `[A-Za-z0-9+/_-]{${HIGH_ENTROPY_MIN_LENGTH}}[A-Za-z0-9+/_-]*={0,2}`;

/** Entropy floor for tokens mixing letter case and/or digits, by token length (bits/char). */
function mixedFloor(length: number): number {
  if (length < 24) return 3.0;
  if (length < 32) return 3.3;
  if (length < 40) return 3.6;
  if (length < 48) return 3.9;
  return 4.1;
}

/** Entropy floor for hex-only tokens (max 4 bits/char), by token length. */
function hexFloor(length: number): number {
  if (length < 32) return 2.2;
  if (length < 64) return 2.6;
  return 3.0;
}

const asciiCounts = new Int32Array(128);

/** Shannon entropy of `text` in bits per character (UTF-16 code units). */
export function shannonEntropy(text: string): number {
  const n = text.length;
  if (n === 0) return 0;
  asciiCounts.fill(0);
  let wide: Map<number, number> | undefined;
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      asciiCounts[code]!++;
    } else {
      wide ??= new Map();
      wide.set(code, (wide.get(code) ?? 0) + 1);
    }
  }
  let bits = 0;
  const add = (count: number): void => {
    const p = count / n;
    bits -= p * Math.log2(p);
  };
  for (let code = 0; code < 128; code++) {
    const count = asciiCounts[code]!;
    if (count > 0) add(count);
  }
  if (wide) for (const count of wide.values()) add(count);
  return bits;
}

const LOWER = 0;
const UPPER = 1;
const DIGIT = 2;
const OTHER = 3;

/**
 * True when `token` (a run of base64/base64url/hex characters) looks like a random secret rather
 * than an identifier, path or number.
 */
export function isHighEntropyToken(token: string): boolean {
  const n = token.length;
  if (n < HIGH_ENTROPY_MIN_LENGTH) return false;

  let lower = 0;
  let upper = 0;
  let digit = 0;
  let hexLetters = 0;
  let nonHex = 0;
  let transitions = 0;
  let previous = -1;
  for (let i = 0; i < n; i++) {
    const code = token.charCodeAt(i);
    let cls: number;
    if (code >= 97 && code <= 122) {
      cls = LOWER;
      lower++;
      if (code <= 102) hexLetters++;
      else nonHex++;
    } else if (code >= 65 && code <= 90) {
      cls = UPPER;
      upper++;
      if (code <= 70) hexLetters++;
      else nonHex++;
    } else if (code >= 48 && code <= 57) {
      cls = DIGIT;
      digit++;
    } else {
      cls = OTHER;
      nonHex++;
    }
    if (previous !== -1 && cls !== previous) transitions++;
    previous = cls;
  }

  const entropy = shannonEntropy(token);

  // Hex digests and hex API keys: digits and a-f letters both present (all-digit runs are numbers).
  // "Mostly hex" counts too: a hex secret glued to a label (`X` + hex, `key_` + hex) is judged
  // against the hex alphabet's lower entropy ceiling (max 4 bits/char), not the mixed-alphabet
  // floor it could never reach.
  const mostlyHex = nonHex <= Math.max(2, Math.floor(n * 0.1));
  if (mostlyHex && digit > 0 && hexLetters > 0 && entropy >= hexFloor(n)) return true;
  if (nonHex === 0) return false;

  const floor = mixedFloor(n);
  const classChangeRatio = transitions / (n - 1);
  // Mixed case plus digits: the signature of base64 / alphanumeric keys.
  if (upper > 0 && lower > 0 && digit > 0) return entropy >= floor;
  // Mixed case, no digits: random tokens flip case about every other character; camelCase
  // identifiers (ratio ~0.25) do not.
  if (upper > 0 && lower > 0) return entropy >= floor && classChangeRatio >= 0.35;
  // One letter case plus digits (base32 seeds, lowercase alphanumeric tokens). With only two
  // classes the class-change ratio is a weak signal, so count direct letter/digit adjacencies:
  // random tokens interleave them, words-with-a-version-number (`node-20`) do not.
  if (digit > 0 && (upper > 0 || lower > 0)) {
    if (entropy < floor - 0.8) return false;
    let adjacencies = 0;
    for (let i = 1; i < n && adjacencies < 2; i++) {
      const a = token.charCodeAt(i - 1);
      const b = token.charCodeAt(i);
      const aDigit = a >= 48 && a <= 57;
      const bDigit = b >= 48 && b <= 57;
      const aLetter = (a >= 65 && a <= 90) || (a >= 97 && a <= 122);
      const bLetter = (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
      if ((aDigit && bLetter) || (aLetter && bDigit)) adjacencies++;
    }
    return adjacencies >= 2;
  }
  // Letters of a single case with no digits, or separators only: words, not keys.
  return false;
}
