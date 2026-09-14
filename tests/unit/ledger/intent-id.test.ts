/**
 * SPEC-015 amendment 2 / SPEC-004: LedgerEvent carries a top-level `intent_id` that is part of the hashed event, so
 * a request still correlates with an acknowledgement whose payload was offloaded to a blob.
 */
import { describe, expect, it } from 'vitest';
import { GENESIS_PREV_HASH, chainHash, sha256Hex } from '../../../src/ledger/hash.js';
import { ExecutionLedger, MAX_INLINE_PAYLOAD_BYTES, type LedgerHead } from '../../../src/ledger/ledger.js';
import { derivePendingIntent } from '../../../src/ledger/pending-intent.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { LedgerActor, LedgerEvent, LedgerEventDraft, LedgerEventType } from '../../../src/model/types.js';
import { validateEvent } from '../../../src/model/validate.js';

const RUN = 'run_01J8Z3K5QW7XV2M9N4P6R8T0AB';

function openLedger(options: { blobs?: Map<string, Uint8Array>; head?: LedgerHead; firstId?: number } = {}): ExecutionLedger {
  let n = options.firstId ?? 0;
  const blobs = options.blobs ?? new Map<string, Uint8Array>();
  return new ExecutionLedger({
    run_id: RUN,
    blobs: {
      async putBlob(data) {
        const ref = { sha256: sha256Hex(data), size: data.byteLength };
        blobs.set(ref.sha256, Uint8Array.from(data));
        return ref;
      },
    },
    clock: { now: () => Date.UTC(2026, 8, 14, 3, 0, 0) },
    newEventId: () => `evt_${(n += 1)}`,
    ...(options.head === undefined ? {} : { head: options.head }),
  });
}

function draft(type: LedgerEventType, payload: Record<string, unknown>, intentId?: string | null): LedgerEventDraft {
  const actor: LedgerActor = type.endsWith('.requested') ? 'agent' : 'runtime';
  return { run_id: RUN, type, actor, payload, ...(intentId === undefined ? {} : { intent_id: intentId }) };
}

/** Events as storage writes and reads them back: one JSON round-trip. */
function stored(events: readonly LedgerEvent[]): LedgerEvent[] {
  return events.map((event) => JSON.parse(JSON.stringify(event)) as LedgerEvent);
}

describe('LedgerEvent.intent_id (SPEC-015 amendment 2)', () => {
  it('is sealed at the top level of the event and is part of the hashed body', async () => {
    const event = await openLedger().append(draft('tool.requested', { tool: 'Bash' }, 'toolu_01A'));

    expect(event.intent_id).toBe('toolu_01A');
    expect(event.payload).toEqual({ tool: 'Bash' });
    expect(validateEvent(event).ok).toBe(true);
    expect(chainHash(GENESIS_PREV_HASH, event)).toBe(event.hash);
    expect(verifyChain([event])).toEqual({ ok: true });

    expect(verifyChain([{ ...event, intent_id: 'toolu_01B' }])).toMatchObject({ ok: false, brokenAtSeq: 1 });
    const { intent_id: _dropped, ...withoutIntent } = event;
    expect(chainHash(GENESIS_PREV_HASH, withoutIntent)).not.toBe(event.hash);
  });

  it('a draft without intent_id seals intent_id: null, and that null is hashed too', async () => {
    const event = await openLedger().append(draft('agent.started', {}));

    expect(Object.hasOwn(event, 'intent_id')).toBe(true);
    expect(event.intent_id).toBeNull();
    expect(chainHash(GENESIS_PREV_HASH, event)).toBe(event.hash);
    const { intent_id: _dropped, ...withoutIntent } = event;
    expect(chainHash(GENESIS_PREV_HASH, withoutIntent)).not.toBe(event.hash);
    expect(verifyChain([{ ...event, intent_id: 'added_later' }])).toMatchObject({ ok: false, brokenAtSeq: 1 });
  });

  it('rejects an intent_id that is not a non-empty string or null, without moving the head', async () => {
    const ledger = openLedger();
    for (const bad of ['', 42, {}, ['toolu_1'], true]) {
      await expect(ledger.append({ ...draft('tool.requested', {}), intent_id: bad } as unknown as LedgerEventDraft)).rejects.toMatchObject({
        code: 'ERR_INVALID_DRAFT',
      });
    }
    expect(ledger.head.seq).toBe(0);

    const sealed = await ledger.append(draft('tool.requested', {}, 'toolu_ok'));
    expect(sealed.seq).toBe(1);
    expect(validateEvent({ ...sealed, intent_id: '' }).ok).toBe(false);
    expect(validateEvent({ ...sealed, intent_id: 7 }).ok).toBe(false);
  });

  it('a tool.requested/tool.completed pair whose >1 MB result is offloaded still correlates, and derivePendingIntent reports it completed', async () => {
    const blobs = new Map<string, Uint8Array>();
    const ledger = openLedger({ blobs });
    const request = await ledger.append(draft('tool.requested', { tool: 'Bash', input: { command: 'cat build.log' } }, 'toolu_big'));
    const result = await ledger.append(draft('tool.completed', { exit_code: 0, stdout: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1) }, 'toolu_big'));

    // The payload went to a blob; the correlation did not.
    expect(result.payload).toBeNull();
    expect(result.payload_ref).not.toBeNull();
    expect(result.payload_ref!.size).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES);
    expect(blobs.has(result.payload_ref!.sha256)).toBe(true);
    expect(result.intent_id).toBe('toolu_big');
    expect(verifyChain([request, result])).toEqual({ ok: true });

    const expected = [
      { kind: 'tool', intent_id: 'toolu_big', request_event_id: request.event_id, status: 'completed', requested_seq: 1, resolved_seq: 2 },
    ];
    expect(derivePendingIntent([request, result])).toEqual(expected);

    // Unchanged after the events are stored and read back.
    const roundTripped = stored([request, result]);
    expect(verifyChain(roundTripped)).toEqual({ ok: true });
    expect(derivePendingIntent(roundTripped)).toEqual(expected);
  });

  it('without a top-level intent_id, the same offloaded acknowledgement cannot be correlated (the gap the amendment closes)', async () => {
    const ledger = openLedger();
    const request = await ledger.append(draft('tool.requested', { tool_call_id: 'call_big', tool: 'Bash' }));
    const result = await ledger.append(draft('tool.completed', { tool_call_id: 'call_big', stdout: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1) }));

    expect(result.payload).toBeNull();
    expect(derivePendingIntent([request, result])).toMatchObject([{ intent_id: 'call_big', status: 'in_progress', resolved_seq: null }]);
  });

  it('correlates failures and side effects by intent_id per kind', async () => {
    const ledger = openLedger();
    const events = [
      await ledger.append(draft('tool.requested', {}, 'toolu_fail')),
      await ledger.append(draft('tool.failed', { error: 'boom' }, 'toolu_fail')),
      await ledger.append(draft('side_effect.requested', { target: 'deploy' }, 'se_1')),
      await ledger.append(draft('side_effect.committed', { log: 'y'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1) }, 'se_1')),
      // Same id, other kind: not an acknowledgement of anything.
      await ledger.append(draft('tool.completed', {}, 'se_1')),
    ];
    expect(events[3]!.payload).toBeNull();

    expect(derivePendingIntent(events)).toMatchObject([
      { kind: 'tool', intent_id: 'toolu_fail', status: 'pending', resolved_seq: 2 },
      { kind: 'side_effect', intent_id: 'se_1', status: 'completed', resolved_seq: 4 },
    ]);
  });

  it('a top-level intent_id takes precedence over a payload id', async () => {
    const ledger = openLedger();
    const events = [
      await ledger.append(draft('tool.requested', { tool_call_id: 'payload_id' }, 'toolu_top')),
      await ledger.append(draft('tool.completed', { tool_call_id: 'payload_id' })),
    ];
    expect(derivePendingIntent(events)).toMatchObject([{ intent_id: 'toolu_top', status: 'in_progress' }]);

    events.push(await ledger.append(draft('tool.completed', {}, 'toolu_top')));
    expect(derivePendingIntent(events)).toMatchObject([{ intent_id: 'toolu_top', status: 'completed', resolved_seq: 3 }]);
  });

  it('events sealed before the amendment (no intent_id member) still validate, verify and correlate, and are never re-hashed', async () => {
    const legacy = (seq: number, prev: string, type: LedgerEventType, payload: Record<string, unknown>): LedgerEvent => {
      const body = {
        event_id: `evt_legacy_${seq}`,
        run_id: RUN,
        seq,
        ts: '2026-09-13T00:00:00.000Z',
        type,
        actor: type.endsWith('.requested') ? 'agent' : 'runtime',
        payload,
        payload_ref: null,
        prev_hash: prev,
      };
      return { ...body, hash: chainHash(prev, body) } as unknown as LedgerEvent;
    };
    const first = legacy(1, GENESIS_PREV_HASH, 'tool.requested', { tool_call_id: 'call_old' });
    const second = legacy(2, first.hash, 'tool.completed', { tool_call_id: 'call_old' });
    const before = stored([first, second]);

    expect(Object.hasOwn(first, 'intent_id')).toBe(false);
    expect(validateEvent(first).ok).toBe(true);
    expect(verifyChain([first, second])).toEqual({ ok: true });
    expect(derivePendingIntent([first, second])).toMatchObject([{ intent_id: 'call_old', status: 'completed', resolved_seq: 2 }]);

    // New appends continue the old chain and carry intent_id; the old events are untouched.
    const ledger = openLedger({ head: { seq: second.seq, hash: second.hash }, firstId: 2 });
    const third = await ledger.append(draft('tool.requested', {}, 'toolu_new'));
    expect(third.prev_hash).toBe(second.hash);
    expect(third.intent_id).toBe('toolu_new');
    expect(verifyChain([first, second, third])).toEqual({ ok: true });
    expect(stored([first, second])).toEqual(before);
  });
});
