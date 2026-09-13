/**
 * verifyChain — SPEC-004 tamper evidence: `{ok} | {ok: false, brokenAtSeq}`.
 *
 * Walks the events in the given order and reports the FIRST seq at which the chain cannot be
 * trusted:
 * - a seq that is not the next one (gap, duplicate or reorder) → the seq that was expected;
 * - a run_id that differs from the first event's, a prev_hash that is not the previous event's
 *   hash, or a hash that does not match the event's own contents → that event's seq.
 *
 * Altering any byte of an event (payload included) breaks that event's own hash, so brokenAtSeq is
 * the altered event. Re-hashing a tampered event moves the break to the next event's prev_hash.
 *
 * Stored events must come back exactly as sealed. An extra member added by storage is part of
 * "event without hash" and breaks the chain. An offloaded payload is covered through payload_ref
 * (its sha256); the blob's bytes are checked against that sha256 by the blob store, not here.
 * Truncating the tail of a chain is only detectable against a known head, which callers compare
 * themselves.
 */
import type { LedgerEvent } from '../model/types.js';
import { chainHash } from './hash.js';
import { GENESIS_HEAD, type LedgerHead } from './ledger.js';

export type ChainVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly brokenAtSeq: number; readonly reason: string };

/**
 * @param events a run's events in seq order.
 * @param from   the chain position just before `events[0]` (GENESIS_HEAD for a whole run), so a slice
 *               such as a storage range read can be verified on its own.
 */
export function verifyChain(events: readonly LedgerEvent[], from: LedgerHead = GENESIS_HEAD): ChainVerification {
  let prevSeq = from.seq;
  let prevHash = from.hash;
  let runId: string | undefined;

  for (const event of events) {
    const expectedSeq = prevSeq + 1;
    if (event.seq !== expectedSeq) {
      return { ok: false, brokenAtSeq: expectedSeq, reason: `expected seq ${expectedSeq}, found ${String(event.seq)}` };
    }
    if (runId === undefined) {
      runId = event.run_id;
    } else if (event.run_id !== runId) {
      return { ok: false, brokenAtSeq: event.seq, reason: `run_id ${String(event.run_id)} differs from ${runId}` };
    }
    if (event.prev_hash !== prevHash) {
      return { ok: false, brokenAtSeq: event.seq, reason: 'prev_hash is not the previous event hash' };
    }
    let computed: string;
    try {
      computed = chainHash(prevHash, event);
    } catch {
      return { ok: false, brokenAtSeq: event.seq, reason: 'event contents are not canonical JSON' };
    }
    if (computed !== event.hash) {
      return { ok: false, brokenAtSeq: event.seq, reason: 'hash does not match the event contents' };
    }
    prevSeq = event.seq;
    prevHash = event.hash;
  }
  return { ok: true };
}
