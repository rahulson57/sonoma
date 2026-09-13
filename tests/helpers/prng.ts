/**
 * Deterministic pseudo-random generation for fixtures.
 *
 * Helpers never use `Math.random()`, `crypto.randomBytes()` or the wall clock, so every
 * generated fixture is a pure function of its seed (SPEC-001 "Determinism").
 */

/** A seeded generator returning floats in [0, 1). */
export type Rng = () => number;

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. */
export function seededRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new TypeError(`seededRng: seed must be an integer, got ${String(seed)}`);
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ALPHABET = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  base32: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  crockford: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
  digits: '0123456789',
  hex: '0123456789abcdef',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
} as const;

/** Draw an integer in [0, maxExclusive). */
export function randomInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/** Draw `length` characters from `alphabet`. */
export function randomChars(rng: Rng, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomInt(rng, alphabet.length));
  return out;
}

/** Pick one element of a non-empty list. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick: items must be non-empty');
  return items[randomInt(rng, items.length)] as T;
}
