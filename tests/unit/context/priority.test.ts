/**
 * SPEC-008 Tier 3 priority: provenance-cited events → the last tool.failed → the most recent delta, newest first.
 * Events cited by Tier 1 claims are hydrated before recency-delta events, even when they are the oldest.
 */
import { describe, expect, it } from 'vitest';
import { createContextBuilder, hydrateEvent } from '../../../src/context/index.js';
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

describe('Tier 3 priority', () => {
  it('hydrates events cited in Tier 1 claim provenance before the last failure and before recency-delta events', async () => {
    const context = await builder().buildResumeContext(restoredAt(c2, events), { maxTokens: 4000 });
    const seqs = context.hydratedEvents.map((event) => event.seq);

    // Not everything fits, so order is what decides.
    expect(seqs.length).toBeLessThan(580);
    expect(seqs.slice(0, 3)).toEqual([2, 550, 11]);
    const delta = seqs.slice(3);
    expect(delta.length).toBeGreaterThan(0);
    // Most recent first, contiguous from the cursor, skipping only the already-cited seq 550.
    const expected = Array.from({ length: 600 - 20 }, (_, i) => 600 - i).filter((seq) => seq !== 550);
    expect(delta).toEqual(expected.slice(0, delta.length));
    expect(delta.every((seq) => seq > c1.ledger_seq)).toBe(true);
    expect(context.tokenEstimate).toBeLessThanOrEqual(4000);
  });

  it('keeps the cited events and drops the whole delta when the budget holds only the cited events', async () => {
    const roomy = await builder().buildResumeContext(restoredAt(c2, events), { maxTokens: 32000 });
    const cited = [hydrateEvent(bySeq(2)), hydrateEvent(bySeq(550))];
    const maxTokens = Math.ceil(contextChars(roomy, cited) / 4);

    const tight = await builder().buildResumeContext(restoredAt(c2, events), { maxTokens });

    expect(tight.hydratedEvents.map((event) => event.seq)).toEqual([2, 550]);
    expect(tight.tokenEstimate).toBeLessThanOrEqual(maxTokens);
  });

  it('without claims, the last failure comes first and then the delta, newest first', async () => {
    const plain = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit() });
    const context = await plain.buildResumeContext(restoredAt(c2, events), { maxTokens: 2000 });
    const seqs = context.hydratedEvents.map((event) => event.seq);

    expect(seqs[0]).toBe(11);
    expect(seqs.slice(1)).toEqual(Array.from({ length: seqs.length - 1 }, (_, i) => 600 - i));
  });
});
