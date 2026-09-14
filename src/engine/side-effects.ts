/**
 * SideEffects as the ledger records them (SPEC-004 SideEffect, SPEC-006 rollback warnings).
 *
 * StorageBackend has no side-effect table: a side effect IS its `side_effect.requested` /
 * `side_effect.committed` events, correlated by `side_effect_id`. Their payloads may carry
 * `{type, target, request_hash, response_hash, reversibility}`.
 *
 * Warnings must never be dropped, so a payload that lacks a member (or had it redacted) still yields a
 * SideEffect: `type`/`target` fall back to "unknown", a hash falls back to the sha256 of the recorded
 * payload (or of its blob), a missing response to NO_RESPONSE_HASH, and reversibility to the SPEC-004
 * default `irreversible`.
 */
import { canonicalJSON } from '../ledger/canonical-json.js';
import { sha256Hex } from '../ledger/hash.js';
import { INTENT_ID_KEYS } from '../ledger/pending-intent.js';
import { DEFAULT_REVERSIBILITY, REVERSIBILITY, type LedgerEvent, type Reversibility, type SideEffect } from '../model/types.js';
import { validateSideEffect } from '../model/validate.js';
import { EngineError } from './errors.js';

/** response_hash of a side effect that was requested but never acknowledged. */
export const NO_RESPONSE_HASH = '0'.repeat(64);

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface Group {
  request?: LedgerEvent;
  commit?: LedgerEvent;
  readonly seqs: number[];
}

function recordedHash(event: LedgerEvent): string {
  return event.payload_ref?.sha256 ?? sha256Hex(canonicalJSON(event.payload ?? {}));
}

function toSideEffect(group: Group): SideEffect {
  const merged: Record<string, unknown> = { ...(group.request?.payload ?? {}), ...(group.commit?.payload ?? {}) };
  const text = (key: string): string | undefined => {
    const value = merged[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const hash = (key: string): string | undefined => {
    const value = merged[key];
    return typeof value === 'string' && SHA256_HEX.test(value) ? value : undefined;
  };
  const reversibility = merged['reversibility'];
  const first = group.request ?? group.commit;
  if (first === undefined) throw new EngineError('ERR_CORRUPT', 'a side-effect group without events');
  const candidate: SideEffect = {
    type: text('type') ?? 'unknown',
    target: text('target') ?? 'unknown',
    request_hash: hash('request_hash') ?? recordedHash(first),
    response_hash: hash('response_hash') ?? (group.commit ? recordedHash(group.commit) : NO_RESPONSE_HASH),
    reversibility: (REVERSIBILITY as readonly unknown[]).includes(reversibility) ? (reversibility as Reversibility) : DEFAULT_REVERSIBILITY,
  };
  const valid = validateSideEffect(candidate);
  if (!valid.ok) throw new EngineError('ERR_CORRUPT', `side effect is invalid: ${valid.errors.join('; ')}`);
  return valid.value;
}

/**
 * The side effects with at least one event whose seq is in `(afterSeq, uptoSeq]`, in order of their first
 * event. Events outside that window still complete a group (a request before `afterSeq` whose commit is
 * inside it is reported, with the request's payload).
 */
export function deriveSideEffects(events: readonly LedgerEvent[], afterSeq: number, uptoSeq = Number.POSITIVE_INFINITY): SideEffect[] {
  const ordered = events
    .filter((event) => (event.type === 'side_effect.requested' || event.type === 'side_effect.committed') && event.seq <= uptoSeq)
    .sort((a, b) => a.seq - b.seq);

  const groups: Group[] = [];
  const current = new Map<string, Group>();
  for (const event of ordered) {
    const id = event.payload?.[INTENT_ID_KEYS.side_effect];
    const key = typeof id === 'string' && id !== '' ? `id:${id}` : `event:${event.event_id}`;
    let group = current.get(key);
    const isRequest = event.type === 'side_effect.requested';
    if (group === undefined || (isRequest && group.request !== undefined) || (!isRequest && group.commit !== undefined)) {
      group = { seqs: [] };
      groups.push(group);
      current.set(key, group);
    }
    if (isRequest) group.request = event;
    else group.commit = event;
    group.seqs.push(event.seq);
  }

  return groups.filter((group) => group.seqs.some((seq) => seq > afterSeq && seq <= uptoSeq)).map(toSideEffect);
}
