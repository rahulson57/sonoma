/**
 * Hash-chain primitives (SPEC-004 LedgerEvent.prev_hash / hash).
 *
 * `hash = sha256(prev_hash ‖ canonicalJSON(event without hash))`, where `‖` concatenates the
 * previous hash as its 64 lowercase hex characters. The first event of a run chains from
 * GENESIS_PREV_HASH.
 */
import { createHash } from 'node:crypto';
import { canonicalJSON } from './canonical-json.js';

/** prev_hash of the first event (seq 1) in every run: 64 zero hex digits. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/** A lowercase sha256 hex digest. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The chain hash of one event. `eventWithoutHash` must not carry a `hash` member (it is ignored
 * if present, so a stored event can be re-hashed directly).
 */
export function chainHash(prevHash: string, eventWithoutHash: object): string {
  const { hash: _ignored, ...body } = eventWithoutHash as { hash?: unknown };
  return createHash('sha256').update(prevHash, 'utf8').update(canonicalJSON(body), 'utf8').digest('hex');
}
