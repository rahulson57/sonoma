/**
 * SPEC-008 Tier 3 priority: provenance-cited events → the last tool.failed → the most recent delta, newest first.
 * Events cited by Tier 1 claims are hydrated before recency-delta events, even when they are the oldest. Each event is
 * considered once, at its highest priority; one that does not fit whole is dropped, counted, and the next is tried
 * (Q-022).
 */
import { describe, expect, it } from 'vitest';
import { createContextBuilder, hydrateEvent, reservedTier3DroppedLine } from '../../../src/context/index.js';
import type { LedgerEvent } from '../../../src/model/types.js';
import { MemoryStorage, checkpointAt, claim, contextChars, fakeGit, restoredAt, sealEvents, staticClaims, type Draft } from './support.js';

const drafts: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
drafts.push({ type: 'model.responded', payload: { request_id: 'req_1', summary: 'decided to use sqlite for the index' } }); // seq 2: cited
for (let i = 3; i <= 9; i += 1) drafts.push({ type: 'workspace.changed', payload: { paths: [`src/early-${i}.ts`] } });
drafts.push({ type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_lint', tool: 'Bash', input: { command: 'npm run lint' } } }); // seq 10
drafts.push({ type: 'tool.failed', payload: { tool_call_id: 'call_lint', error: 'lint failed' } }); // seq 11: the last failure
for (let i = 12; i <= 19; i += 1) drafts.push({ type: 'workspace.changed', payload: { paths: [`src/mid-${i}.ts`] } });
drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }); // seq 20: parent cursor
for (let i = 21; i <= 599; i += 1) drafts.push({ type: 'workspace.changed', payload: { paths: [`src/delta-${i}.ts`], note: 'recent change' } });
drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_2' } }); // seq 600

const events = sealEvents(drafts);
const bySeq = (seq: number): LedgerEvent => {
  const event = events[seq - 1];
  if (event === undefined) throw new Error(`no event at seq ${seq}`);
  return event;
};
const c1 = checkpointAt({ n: 1, ledgerSeq: 20 });
const c2 = checkpointAt({ n: 2, ledgerSeq: 600, parent: c1 });
const claims = [claim('decision', 'Use SQLite as the index', [bySeq(2).event_id]), claim('current_state', 'Half way through the delta', [bySeq(550).event_id])];

function builder(): ReturnType<typeof createContextBuilder> {
  return createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit(), claims: staticClaims(claims) });
}

const COUNTS_PREFIX = 'left out because they do not fit whole: ';

function countsLine(preamble: string): string {
  const line = preamble.split('\n').find((candidate) => candidate.startsWith(COUNTS_PREFIX));
  if (line === undefined) throw new Error('preamble has no Tier 3 counts line');
  return line;
}

describe('Tier 3 priority', () => {
  it('hydrates events cited in Tier 1 claim provenance before the last failure and before recency-delta events', async () => {
    const context = await builder().buildResumeContext(restoredAt(c2, events), { maxTokens: 4000 });
    const seqs = context.hydratedEvents.map((event) => event.seq);

    // Not everything fits, so order is what decides.
    expect(seqs.length).toBeLessThan(580);
    expect(seqs.slice(0, 3)).toEqual([2, 550, 11]);
    const delta = seqs.slice(3);
    expect(delta.length).toBeGreaterThan(0);
    // Most recent first, contiguous from the cursor, skipping only the already-cited seq 550 (considered once).
    const expected = Array.from({ length: 600 - 20 }, (_, i) => 600 - i).filter((seq) => seq !== 550);
    expect(delta).toEqual(expected.slice(0, delta.length));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(delta.every((seq) => seq > c1.ledger_seq)).toBe(true);
    expect(context.tokenEstimate).toBeLessThanOrEqual(4000);
  });

  it('keeps the cited events and drops the rest whole when the budget holds only the cited events', async () => {
    const roomy = await builder().buildResumeContext(restoredAt(c2, events), { maxTokens: 32000 });
    const cited = [hydrateEvent(bySeq(2)), hydrateEvent(bySeq(550))];
    // A build reserves the widest Tier 3 counts line before it selects events.
    const reserve = reservedTier3DroppedLine(c2.ledger_seq).length - countsLine(roomy.systemPreamble).length;
    const maxTokens = Math.ceil((contextChars(roomy, cited) + reserve) / 4);

    const tight = await builder().buildResumeContext(restoredAt(c2, events), { maxTokens });

    expect(tight.hydratedEvents.map((event) => event.seq)).toEqual([2, 550]);
    expect(tight.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    expect(countsLine(tight.systemPreamble)).toMatch(/^left out because they do not fit whole: cited 0, last failure 1, delta [1-9]\d*$/);
  });

  it('without claims, the last failure comes first and then the delta, newest first', async () => {
    const plain = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit() });
    const context = await plain.buildResumeContext(restoredAt(c2, events), { maxTokens: 2000 });
    const seqs = context.hydratedEvents.map((event) => event.seq);

    expect(seqs[0]).toBe(11);
    expect(seqs.slice(1)).toEqual(Array.from({ length: seqs.length - 1 }, (_, i) => 600 - i));
  });

  it('drops an oversized cited event whole, still hydrates the cited events and delta that fit, and counts what it dropped', async () => {
    const big: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
    big.push({ type: 'model.responded', payload: { request_id: 'req_big', summary: 'z'.repeat(40_000) } }); // seq 2: cited, ~10k tokens
    for (let i = 3; i <= 19; i += 1) big.push({ type: 'workspace.changed', payload: { paths: [`src/early-${i}.ts`] } });
    big.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }); // seq 20
    for (let i = 21; i <= 59; i += 1) big.push({ type: 'workspace.changed', payload: { paths: [`src/delta-${i}.ts`] } });
    big.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_2' } }); // seq 60
    const ledger = sealEvents(big);
    const at = (seq: number): string => ledger[seq - 1]?.event_id ?? '';
    const b1 = checkpointAt({ n: 1, ledgerSeq: 20 });
    const b2 = checkpointAt({ n: 2, ledgerSeq: 60, parent: b1 });
    const source = staticClaims([claim('decision', 'Summarised in the long response', [at(2)]), claim('current_state', 'Mid-delta', [at(30)])]);

    const context = await createContextBuilder({ storage: new MemoryStorage(ledger, [b1, b2]), git: fakeGit(), claims: source }).buildResumeContext(
      restoredAt(b2, ledger),
      { maxTokens: 8000 },
    );
    const seqs = context.hydratedEvents.map((event) => event.seq);

    expect(seqs).not.toContain(2);
    // The cited event that fits comes first; then the whole delta (20, 60], newest first, without the cited seq 30 again.
    expect(seqs[0]).toBe(30);
    expect(seqs.slice(1)).toEqual(Array.from({ length: 60 - 20 }, (_, i) => 60 - i).filter((seq) => seq !== 30));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(countsLine(context.systemPreamble)).toBe('left out because they do not fit whole: cited 1, last failure 0, delta 0');
    expect(context.tokenEstimate).toBeLessThanOrEqual(8000);
  });

  it('considers a last failure that lies in the delta once: dropped and counted as the last failure, not again as delta', async () => {
    const run: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
    run.push({ type: 'model.responded', payload: { request_id: 'req_long', summary: 'q'.repeat(20_000) } }); // seq 2: cited, fits alone
    for (let i = 3; i <= 19; i += 1) run.push({ type: 'workspace.changed', payload: { paths: [`src/early-${i}.ts`] } });
    run.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }); // seq 20
    for (let i = 21; i <= 40; i += 1) {
      run.push(
        i === 30
          ? { type: 'tool.failed', payload: { tool_call_id: 'call_x', error: 'e'.repeat(12_000) } } // seq 30: the last failure, inside the delta
          : { type: 'workspace.changed', payload: { paths: [`src/delta-${i}.ts`] } },
      );
    }
    run.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_2' } }); // seq 41
    const ledger = sealEvents(run);
    const f1 = checkpointAt({ n: 1, ledgerSeq: 20 });
    const f2 = checkpointAt({ n: 2, ledgerSeq: 41, parent: f1 });
    const source = staticClaims([claim('decision', 'Recorded in the long summary', [ledger[1]?.event_id ?? ''])]);

    const context = await createContextBuilder({ storage: new MemoryStorage(ledger, [f1, f2]), git: fakeGit(), claims: source }).buildResumeContext(
      restoredAt(f2, ledger),
      { maxTokens: 8000 },
    );
    const seqs = context.hydratedEvents.map((event) => event.seq);

    // The cited event fits; after it the failure does not, and every smaller delta event still does.
    expect(seqs).toEqual([2, ...Array.from({ length: 41 - 20 }, (_, i) => 41 - i).filter((seq) => seq !== 30)]);
    expect(countsLine(context.systemPreamble)).toBe('left out because they do not fit whole: cited 0, last failure 1, delta 0');
    expect(context.tokenEstimate).toBeLessThanOrEqual(8000);
  });
});
