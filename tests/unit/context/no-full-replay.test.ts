/**
 * SPEC-008 "Must never": replay or include the full transcript, or read the ledger outside [0, ledgerCursor].
 * A 100k-event ledger (tests/helpers fakeLedgerEvents) with events beyond the checkpoint's cursor.
 */
import { describe, expect, it } from 'vitest';
import { createContextBuilder } from '../../../src/context/index.js';
import { MemoryStorage, checkpointAt, claim, fakeGit, restoredAt, sealFakeLedger, staticClaims } from './support.js';

const LEDGER_SIZE = 100_000;
const events = sealFakeLedger(LEDGER_SIZE, 42);
const runId = events[0]?.run_id ?? '';

describe('no full replay', () => {
  it('given a 100k-event ledger, hydrates fewer than 100k events and none with seq > ledgerCursor', async () => {
    const cursor = 80_000;
    const c1 = checkpointAt({ n: 1, ledgerSeq: 40_000, runId });
    const c2 = checkpointAt({ n: 2, ledgerSeq: cursor, parent: c1 });
    const early = events[9];
    const beyond = events[89_999];
    if (early === undefined || beyond === undefined) throw new Error('fixture ledger too short');
    const storage = new MemoryStorage(events, [c1, c2]);
    const claims = staticClaims([claim('decision', 'Keep the early design', [early.event_id]), claim('plan', 'Refers to the future', [beyond.event_id])]);
    const builder = createContextBuilder({ storage, git: fakeGit(), claims });
    const restored = restoredAt(c2, events);

    for (const maxTokens of [2000, 8000, 32000]) {
      const context = await builder.buildResumeContext(restored, { maxTokens });
      const seqs = context.hydratedEvents.map((event) => event.seq);

      expect(context.hydratedEvents.length).toBeGreaterThan(0);
      expect(context.hydratedEvents.length).toBeLessThan(LEDGER_SIZE);
      expect(seqs.every((seq) => seq >= 1 && seq <= cursor)).toBe(true);
      expect(new Set(context.hydratedEvents.map((event) => event.event_id)).size).toBe(context.hydratedEvents.length);
      // Cited provenance inside the cursor is hydrated; a citation past the cursor is never read into the context.
      expect(context.hydratedEvents[0]?.event_id).toBe(early.event_id);
      expect(context.hydratedEvents.some((event) => event.event_id === beyond.event_id)).toBe(false);
    }

    expect(storage.ranges.length).toBeGreaterThan(0);
    for (const range of storage.ranges) {
      expect(range.runId).toBe(runId);
      expect(range.fromSeq).toBeGreaterThanOrEqual(1);
      expect(range.toSeq).toBeLessThanOrEqual(cursor);
      expect(range.fromSeq).toBeLessThanOrEqual(range.toSeq);
    }
  });

  it('hydrates fewer than 100k events for a parentless checkpoint at the ledger head', async () => {
    const head = checkpointAt({ n: 1, ledgerSeq: LEDGER_SIZE, runId });
    const storage = new MemoryStorage(events, [head]);
    const builder = createContextBuilder({ storage, git: fakeGit() });

    const context = await builder.buildResumeContext(restoredAt(head, events), { maxTokens: 32000 });

    expect(context.hydratedEvents.length).toBeGreaterThan(0);
    expect(context.hydratedEvents.length).toBeLessThan(LEDGER_SIZE);
    expect(context.tokenEstimate).toBeLessThanOrEqual(32000);
    // Candidates are read a page at a time; the walk does not fetch the ledger in one range.
    expect(storage.ranges.every((range) => range.toSeq - range.fromSeq + 1 <= 1024)).toBe(true);
  });

  it('refuses events storage returns outside the requested range', async () => {
    const c1 = checkpointAt({ n: 1, ledgerSeq: 500, runId });
    const leaky = new MemoryStorage(events, [c1]);
    const storage = {
      getCheckpoint: leaky.getCheckpoint.bind(leaky),
      getEvents: async () => events.slice(0, 600),
    };
    const builder = createContextBuilder({ storage, git: fakeGit() });

    await expect(builder.buildResumeContext(restoredAt(c1, events))).rejects.toMatchObject({ code: 'ERR_CORRUPT' });
  });
});
