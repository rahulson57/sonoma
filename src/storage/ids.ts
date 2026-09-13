/** Identifier generation for runs: SPEC-004 `run_<ulid>`. Time and randomness are injectable. */
import { randomBytes } from 'node:crypto';

export const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RandomSource = (size: number) => Uint8Array;

export const cryptoRandom: RandomSource = (size) => randomBytes(size);

const MAX_ULID_TIME = 2 ** 48 - 1;

/** A 26-character ULID: 10 chars of 48-bit millisecond time, then 16 chars of 80-bit randomness. */
export function ulid(timeMs: number, random: RandomSource = cryptoRandom): string {
  const time = Math.floor(timeMs);
  if (!Number.isFinite(time) || time < 0 || time > MAX_ULID_TIME) {
    throw new RangeError(`ulid: time must be within 0..2^48-1 ms, got ${String(timeMs)}`);
  }
  let rest = time;
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD_BASE32.charAt(rest % 32) + timePart;
    rest = Math.floor(rest / 32);
  }

  const bytes = random(10);
  if (bytes.byteLength < 10) throw new RangeError('ulid: random source returned fewer than 10 bytes');
  let bits = 0n;
  for (let i = 0; i < 10; i += 1) bits = (bits << 8n) | BigInt(bytes[i] ?? 0);
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) {
    randomPart = CROCKFORD_BASE32.charAt(Number(bits & 31n)) + randomPart;
    bits >>= 5n;
  }
  return timePart + randomPart;
}
