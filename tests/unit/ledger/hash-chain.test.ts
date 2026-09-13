import { beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../helpers/clock.js';
import { fakeLedgerEvents } from '../../helpers/ledger.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { chainHash, sha256Hex } from '../../../src/ledger/hash.js';
import { ExecutionLedger, GENESIS_HEAD, LedgerError, type BlobSink, type LedgerHead } from '../../../src/ledger/ledger.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { LedgerEvent, LedgerEventDraft } from '../../../src/model/types.js';

const N = 10_000;
const RUN = 'run_01J8Z3K5QW7XV2M9N4P6R8T0AB';

const memoryBlobs: BlobSink = {
  async putBlob(data) {
    return { sha256: sha256Hex(data), size: data.byteLength };
  },
};

function newLedger(runId: string, head: LedgerHead = GENESIS_HEAD): ExecutionLedger {
  const clock = fixedClock(Date.UTC(2026, 8, 13, 12, 0, 0));
  let ids = head.seq;
  return new ExecutionLedger({
    run_id: runId,
    blobs: memoryBlobs,
    head,
    clock: {
      now: () => {
        clock.tick(1);
        return clock.now();
      },
    },
    newEventId: () => `evt_${String((ids += 1)).padStart(8, '0')}`,
  });
}

function toDraft(event: Pick<LedgerEventDraft, 'run_id' | 'type' | 'actor' | 'payload'>): LedgerEventDraft {
  return { run_id: event.run_id, type: event.type, actor: event.actor, payload: event.payload };
}

async function appendAll(ledger: ExecutionLedger, drafts: readonly LedgerEventDraft[]): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for (const draft of drafts) out.push(await ledger.append(draft));
  return out;
}

function firstStringLeaf(node: unknown): { holder: Record<string, unknown>; key: string } | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = firstStringLeaf(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return { holder: record, key };
    const found = firstStringLeaf(value);
    if (found) return found;
  }
  return null;
}

/** A deep copy of `event` with exactly one ASCII byte of one payload string changed; null if it has none. */
function withOnePayloadByteAltered(event: LedgerEvent): LedgerEvent | null {
  const copy = structuredClone(event) as { payload: Record<string, unknown> | null };
  const leaf = copy.payload ? firstStringLeaf(copy.payload) : null;
  if (!leaf) return null;
  const text = leaf.holder[leaf.key] as string;
  const last = text.charCodeAt(text.length - 1);
  if (last > 0x7f) return null;
  leaf.holder[leaf.key] = text.slice(0, -1) + String.fromCharCode(last === 0x61 ? 0x62 : 0x61);
  return copy as unknown as LedgerEvent;
}

describe('hash-chained ledger over 10,000 fakeLedgerEvents() (SPEC-004)', () => {
  let runId: string;
  let events: LedgerEvent[];

  beforeAll(async () => {
    const fakes = fakeLedgerEvents(N, 42);
    runId = fakes[0]!.run_id;
    events = await appendAll(newLedger(runId), fakes.map(toDraft));
  }, 120_000);

  it('appending yields strictly increasing seq, starting at 1 from the genesis hash', () => {
    expect(events).toHaveLength(N);
    const firstBad = events.findIndex((e, i) => e.seq !== i + 1 || (i > 0 && e.seq <= events[i - 1]!.seq));
    expect(firstBad).toBe(-1);
    expect(events[0]!.prev_hash).toBe(GENESIS_HEAD.hash);
  });

  it('verifyChain returns ok for the untouched chain', () => {
    expect(verifyChain(events)).toEqual({ ok: true });
  });

  it("altering one payload byte makes verifyChain return brokenAtSeq equal to that event's seq", () => {
    const index = events.findIndex((e, i) => i >= N / 2 && withOnePayloadByteAltered(e) !== null);
    expect(index).toBeGreaterThanOrEqual(N / 2);
    const original = events[index]!;
    const altered = withOnePayloadByteAltered(original)!;

    const before = Buffer.from(canonicalJSON(original.payload), 'utf8');
    const after = Buffer.from(canonicalJSON(altered.payload), 'utf8');
    expect(after.byteLength).toBe(before.byteLength);
    expect(before.filter((byte, i) => byte !== after[i]).length).toBe(1);

    const tampered = [...events];
    tampered[index] = altered;
    expect(verifyChain(tampered)).toMatchObject({ ok: false, brokenAtSeq: original.seq });
    expect(verifyChain(tampered.slice(0, index))).toEqual({ ok: true });
  });

  it('re-hashing a tampered event moves the break to the next event', () => {
    const index = 7_000;
    const original = events[index]!;
    const body = { ...original, payload: { ...original.payload, forged: true } };
    const forged = { ...body, hash: chainHash(original.prev_hash, body) } as LedgerEvent;
    const tampered = [...events];
    tampered[index] = forged;
    expect(verifyChain(tampered)).toMatchObject({ ok: false, brokenAtSeq: original.seq + 1 });
  });

  it('detects a changed prev_hash, a deleted event and a reordered pair at the first affected seq', () => {
    const relinked = [...events];
    relinked[100] = { ...events[100]!, prev_hash: 'f'.repeat(64) };
    expect(verifyChain(relinked)).toMatchObject({ ok: false, brokenAtSeq: 101 });

    expect(verifyChain(events.filter((_, i) => i !== 200))).toMatchObject({ ok: false, brokenAtSeq: 201 });

    const swapped = [...events];
    swapped[300] = events[301]!;
    swapped[301] = events[300]!;
    expect(verifyChain(swapped)).toMatchObject({ ok: false, brokenAtSeq: 301 });
  });

  it('verifies a slice of the chain from an anchor head', () => {
    const anchor = events[4_999]!;
    expect(verifyChain(events.slice(5_000), { seq: anchor.seq, hash: anchor.hash })).toEqual({ ok: true });
    expect(verifyChain(events.slice(5_000))).toMatchObject({ ok: false, brokenAtSeq: 1 });
  });

  it('appended events are immutable', () => {
    const event = events.find((e) => e.payload !== null && Object.keys(e.payload).length > 0)!;
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as { seq: number }).seq = 99;
    }).toThrow(TypeError);
    expect(() => {
      (event.payload as Record<string, unknown>)['injected'] = 1;
    }).toThrow(TypeError);
  });

  it('a ledger re-opened at the head continues the same chain', async () => {
    const last = events[events.length - 1]!;
    const more = await appendAll(
      newLedger(runId, { seq: last.seq, hash: last.hash }),
      fakeLedgerEvents(5, 9).map((e) => toDraft({ ...e, run_id: runId })),
    );
    expect(more[0]!.seq).toBe(N + 1);
    expect(verifyChain([...events, ...more])).toEqual({ ok: true });
  });
});

describe('ExecutionLedger append contract', () => {
  const base = { run_id: RUN, type: 'run.created', actor: 'runtime', payload: {} } as const;

  it('rejects an event type outside the enum without advancing the head', async () => {
    const ledger = newLedger(RUN);
    const attempt = ledger.append({ ...base, type: 'state.declared' as never });
    await expect(attempt).rejects.toBeInstanceOf(LedgerError);
    await expect(attempt).rejects.toMatchObject({ code: 'ERR_UNKNOWN_EVENT_TYPE' });
    expect(ledger.head).toEqual(GENESIS_HEAD);
    expect((await ledger.append(base)).seq).toBe(1);
  });

  it('rejects another run, an unknown actor, non-JSON payloads and caller-supplied chain fields', async () => {
    const ledger = newLedger(RUN);
    await expect(ledger.append({ ...base, run_id: 'run_01J8Z3K5QW7XV2M9N4P6R8T0AC' })).rejects.toMatchObject({
      code: 'ERR_RUN_MISMATCH',
    });
    await expect(ledger.append({ ...base, actor: 'adapter' as never })).rejects.toMatchObject({ code: 'ERR_UNKNOWN_ACTOR' });
    await expect(ledger.append({ ...base, payload: { when: new Date(0) } })).rejects.toMatchObject({
      code: 'ERR_INVALID_PAYLOAD',
    });
    await expect(ledger.append({ ...base, payload: [] as never })).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    await expect(ledger.append({ ...base, seq: 7 } as never)).rejects.toMatchObject({ code: 'ERR_INVALID_DRAFT' });
    expect(ledger.head).toEqual(GENESIS_HEAD);
  });

  it('keeps its own copy of the payload', async () => {
    const payload = { note: 'before' };
    const event = await newLedger(RUN).append({ ...base, payload });
    payload.note = 'after';
    expect(event.payload).toEqual({ note: 'before' });
    expect(verifyChain([event])).toEqual({ ok: true });
  });

  it('serialises concurrent appends into one contiguous chain', async () => {
    const ledger = newLedger(RUN);
    const appended = await Promise.all(
      Array.from({ length: 50 }, (_, i) => ledger.append({ ...base, type: 'workspace.changed', payload: { i } })),
    );
    expect(appended.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(verifyChain(appended)).toEqual({ ok: true });
  });

  it('refuses an inconsistent starting head', () => {
    expect(() => newLedger(RUN, { seq: 0, hash: 'a'.repeat(64) })).toThrow(LedgerError);
    expect(() => newLedger(RUN, { seq: -1, hash: GENESIS_HEAD.hash })).toThrow(LedgerError);
    expect(() => newLedger(RUN, { seq: 3, hash: 'not-a-hash' })).toThrow(LedgerError);
  });
});
