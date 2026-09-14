/**
 * Budget arithmetic and the hydrated form of a ledger event (SPEC-008 "Truncation policy").
 *
 * Every value the builder returns is a plain JSON copy with members in canonical order, so `JSON.stringify` of a
 * ResumeContext depends only on the values, never on how the caller built its objects (byte-identical output).
 *
 * An event is never cut: its payload is either inline as recorded, or, when its canonical JSON is larger than
 * 4 KB, replaced as a whole by `payload_ref` {sha256 of those canonical bytes, byte length}. That ref is a content
 * address the ledger's payload can be checked against; the builder never reads or writes a blob. Events whose
 * payload was already offloaded to CAS (`payload: null`) pass through with their stored `payload_ref`.
 */
import { CanonicalJsonError, canonicalJSON } from '../ledger/canonical-json.js';
import { sha256Hex } from '../ledger/hash.js';
import type { LedgerEvent } from '../model/types.js';
import { ContextError } from './errors.js';
import { CHARS_PER_TOKEN, INLINE_PAYLOAD_MAX_BYTES } from './types.js';

export function tokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** A plain JSON copy with object members in canonical (sorted) order. */
export function normalizeJson<T>(value: T, what: string): T {
  try {
    return JSON.parse(canonicalJSON(value)) as T;
  } catch (err) {
    if (err instanceof CanonicalJsonError) throw new ContextError('ERR_CORRUPT', `${what} is not plain JSON: ${err.message}`, { cause: err });
    throw err;
  }
}

/** The event as it appears in `hydratedEvents`: whole, with an over-4 KB payload referenced by sha256. */
export function hydrateEvent(event: LedgerEvent): LedgerEvent {
  const copy = normalizeJson(event, `ledger event seq ${String(event.seq)}`);
  if (copy.payload === null) return copy;
  const bytes = Buffer.from(canonicalJSON(copy.payload), 'utf8');
  if (bytes.byteLength <= INLINE_PAYLOAD_MAX_BYTES) return copy;
  // Spreading keeps the canonical member order: payload and payload_ref are replaced in place.
  return { ...copy, payload: null, payload_ref: { sha256: sha256Hex(bytes), size: bytes.byteLength } };
}
