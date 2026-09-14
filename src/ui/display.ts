/**
 * SPEC-012 display policy (lossy). A payload over 64 KB is shown as a `sha256:` ref with its size, never inlined:
 * - an inline payload whose canonical JSON is over 64 KB shows the sha256 of those bytes (the hash the ledger would
 *   give it as a blob);
 * - a payload the ledger already offloaded (`payload_ref`, over 1 MiB) shows that BlobRef. Its content is never read.
 * Stored values are shown as stored, so redacted values appear as their `[REDACTED:<kind>]` marker and nothing is
 * reconstructed.
 */
import { canonicalJSON } from '../ledger/canonical-json.js';
import { sha256Hex } from '../ledger/hash.js';
import type { LedgerEvent } from '../model/types.js';
import type { InspectorEvent, PayloadRef } from './types.js';

export const MAX_INLINE_DISPLAY_BYTES = 64 * 1024;

export function payloadRef(sha256: string, size: number): PayloadRef {
  return { ref: `sha256:${sha256}`, size };
}

export function displayEvent(event: LedgerEvent): InspectorEvent {
  const base = { seq: event.seq, type: event.type, actor: event.actor, ts: event.ts };
  if (event.payload_ref !== null) {
    return { ...base, payload: null, payloadRef: payloadRef(event.payload_ref.sha256, event.payload_ref.size) };
  }
  if (event.payload === null) return { ...base, payload: null, payloadRef: null };
  const bytes = Buffer.from(canonicalJSON(event.payload), 'utf8');
  if (bytes.byteLength > MAX_INLINE_DISPLAY_BYTES) {
    return { ...base, payload: null, payloadRef: payloadRef(sha256Hex(bytes), bytes.byteLength) };
  }
  return { ...base, payload: event.payload, payloadRef: null };
}
