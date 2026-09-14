/**
 * SPEC-007 "Input bounding": the prompt carries only ledger events with seq in (prevCursor, cursor], never
 * the full run, built here from fakeLedgerEvents(). The fake source returns the whole run on purpose.
 */
import { describe, expect, it } from 'vitest';
import { distill } from '../../../src/distill/index.js';
import { fakeLedgerEvents } from '../../helpers/ledger.js';
import { depsFor, fakeRun, ledgerLines, reply, seqs, spyProvider } from './support.js';

describe('distill() prompt bounding', () => {
  it('sends only the ledger events with seq in (prevCursor, cursor]', async () => {
    const run = await fakeRun({ events: 120, prevCursor: 40, cursor: 90 });
    const provider = spyProvider(reply([]));

    await distill(run.request, depsFor(run, provider));

    expect(provider.prompts).toHaveLength(1);
    const prompt = provider.prompts[0]!;
    expect(ledgerLines(prompt).map((event) => event['seq'])).toEqual(seqs(41, 90));
    for (const event of run.events) {
      const inside = event.seq > 40 && event.seq <= 90;
      expect(prompt.includes(event.event_id), `event seq ${event.seq}`).toBe(inside);
    }
    expect(run.calls.readEvents).toEqual([{ fromSeq: 41, toSeq: 90 }]);
  });

  it('starts at seq 1 for the first checkpoint of a run', async () => {
    const run = await fakeRun({ events: 30, prevCursor: 0, cursor: 12 });
    const provider = spyProvider(reply([]));

    await distill(run.request, depsFor(run, provider));

    expect(ledgerLines(provider.prompts[0]!).map((event) => event['seq'])).toEqual(seqs(1, 12));
  });

  it('sends no events and does not read the ledger when the delta is empty', async () => {
    const run = await fakeRun({ events: 30, prevCursor: 25, cursor: 25 });
    const provider = spyProvider(reply([]));

    await distill(run.request, depsFor(run, provider));

    expect(ledgerLines(provider.prompts[0]!)).toEqual([]);
    expect(provider.prompts[0]).toContain('LEDGER (0 events');
    expect(run.calls.readEvents).toEqual([]);
  });

  it('reads offloaded payloads from CAS only for events inside the range', async () => {
    const run = await fakeRun({ events: 120, prevCursor: 40, cursor: 90, offload: [10, 50, 60, 95] });
    const provider = spyProvider(reply([]));

    await distill(run.request, depsFor(run, provider));

    const refOf = (seq: number) => run.events[seq - 1]!.payload_ref!.sha256;
    expect(run.calls.readBlob).toEqual([refOf(50), refOf(60)]);
    const sent = ledgerLines(provider.prompts[0]!).find((event) => event['seq'] === 50)!;
    expect(sent['payload_ref']).toBe(refOf(50));
    expect(sent['payload']).toEqual(fakeLedgerEvents(120, 7)[49]!.payload);
  });

  it('refuses a ledgerRange that does not start at the parent checkpoint cursor, before reading the ledger or calling the provider', async () => {
    const run = await fakeRun({ events: 120, prevCursor: 40, cursor: 90 });
    const provider = spyProvider(reply([]));

    // Widened towards the start of the run (0 would be the full trajectory), or narrowed past the parent's cursor.
    for (const from of [0, 39, 41, 60]) {
      await expect(distill({ ...run.request, ledgerRange: [from, 90] }, depsFor(run, provider))).rejects.toMatchObject({
        code: 'DISTILL_INPUT_MISMATCH',
      });
    }

    expect(provider.prompts).toHaveLength(0);
    expect(run.calls.readEvents).toEqual([]);
    expect(run.calls.readCheckpoint).toContain('c_1');
  });

  it('refuses a first checkpoint whose ledgerRange does not start at 0', async () => {
    const run = await fakeRun({ events: 30, prevCursor: 0, cursor: 12 });
    const provider = spyProvider(reply([]));

    await expect(distill({ ...run.request, ledgerRange: [5, 12] }, depsFor(run, provider))).rejects.toMatchObject({ code: 'DISTILL_INPUT_MISMATCH' });

    expect(provider.prompts).toHaveLength(0);
    expect(run.calls.readEvents).toEqual([]);
  });
});
