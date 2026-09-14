/**
 * Tier 3 follows the checkpoint's own lineage (DEC-025/031/032). A restore to cursor T recorded at seq L abandons
 * (T, L]: the restored workspace does not contain those effects, so none of those events is hydrated, not as delta,
 * not as the last failure, and not as cited provenance. Nested restores reinstate the restored checkpoint's history.
 */
import { describe, expect, it } from 'vitest';
import { createContextBuilder, restoreTarget } from '../../../src/context/index.js';
import type { LedgerEvent } from '../../../src/model/types.js';
import { MemoryStorage, RUN_ID, checkpointAt, claim, fakeGit, restoredAt, sealEvents, staticClaims, type Draft } from './support.js';

const c1 = checkpointAt({ n: 1, ledgerSeq: 3 });
const c2 = checkpointAt({ n: 2, ledgerSeq: 7, parent: c1 });

const drafts: Draft[] = [
  { type: 'run.created', payload: { agent: 'claude-code' } }, // 1
  { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_read', tool: 'Read' } }, // 2
  { type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }, // 3 = c_1
  { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_A', tool: 'Edit' } }, // 4
  { type: 'tool.completed', payload: { tool_call_id: 'call_A' } }, // 5
  { type: 'tool.failed', payload: { tool_call_id: 'call_probe', error: 'probe failed' } }, // 6
  { type: 'checkpoint.created', payload: { checkpoint_id: 'c_2' } }, // 7 = c_2
  { type: 'agent.resumed', payload: { checkpoint_id: 'c_1', ledger_seq: 3, workspace_commit: c1.workspace_commit } }, // 8: abandons (3, 8]
  { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_B', tool: 'Edit' } }, // 9
  { type: 'tool.completed', payload: { tool_call_id: 'call_B' } }, // 10
  { type: 'checkpoint.created', payload: { checkpoint_id: 'c_3' } }, // 11 = c_3 (parent c_1)
  { type: 'agent.resumed', payload: { checkpoint_id: 'c_2', ledger_seq: 7, workspace_commit: c2.workspace_commit } }, // 12: abandons (7, 12]
  { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_C', tool: 'Write' } }, // 13
  { type: 'checkpoint.created', payload: { checkpoint_id: 'c_4' } }, // 14 = c_4 (parent c_2)
];
const events = sealEvents(drafts);
const c3 = checkpointAt({ n: 3, ledgerSeq: 11, parent: c1 });
const c4 = checkpointAt({ n: 4, ledgerSeq: 14, parent: c2 });

function at(seq: number): LedgerEvent {
  const event = events[seq - 1];
  if (event === undefined) throw new Error(`no event at seq ${seq}`);
  return event;
}

function claimsCitingCallAAndCallB(): ReturnType<typeof staticClaims> {
  return staticClaims([claim('current_state', 'call_A edited the file', [at(5).event_id]), claim('current_state', 'call_B edited the file', [at(10).event_id])]);
}

describe('abandoned windows', () => {
  it('reads restore targets only from well-formed restore events', () => {
    expect(restoreTarget(at(8))).toBe(3);
    expect(restoreTarget(at(12))).toBe(7);
    expect(restoreTarget(at(4))).toBeNull();
    expect(restoreTarget({ ...at(8), payload: null })).toBeNull();
    expect(restoreTarget({ ...at(8), payload: { ledger_seq: 8 } })).toBeNull();
  });

  it('after resume(c_1), the next checkpoint hydrates none of the events the restore abandoned', async () => {
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2, c3, c4]), git: fakeGit(), claims: claimsCitingCallAAndCallB() });

    const context = await builder.buildResumeContext(restoredAt(c3, events), { maxTokens: 32000 });
    const seqs = context.hydratedEvents.map((event) => event.seq);

    // Cited call_B (10) first; the delta (3, 11] minus the abandoned window (3, 8] is 11, 10, 9.
    expect(seqs).toEqual([10, 11, 9]);
    // call_A's acknowledgement (5), the failure inside the window (6) and the restore itself (8) are not on c_3's lineage.
    expect(seqs).not.toContain(5);
    expect(seqs).not.toContain(6);
    expect(seqs).not.toContain(8);
  });

  it('a nested resume(c_2) reinstates c_2’s own history (DEC-032)', async () => {
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2, c3, c4]), git: fakeGit(), claims: claimsCitingCallAAndCallB() });

    const context = await builder.buildResumeContext(restoredAt(c4, events), { maxTokens: 32000 });
    const seqs = context.hydratedEvents.map((event) => event.seq);

    // Cited call_A (5) is on c_4's lineage again; cited call_B (10) was abandoned by resume(c_2).
    // Then the last failure on the lineage (6), then the delta (7, 14] minus (7, 12]: 14, 13.
    expect(seqs).toEqual([5, 6, 14, 13]);
    expect(seqs).not.toContain(10);
  });

  it('never reads a range past the cursor while following restores', async () => {
    const storage = new MemoryStorage(events, [c1, c2, c3, c4]);
    const builder = createContextBuilder({ storage, git: fakeGit() });

    await builder.buildResumeContext(restoredAt(c3, events));

    expect(storage.ranges.length).toBeGreaterThan(0);
    expect(storage.ranges.every((range) => range.runId === RUN_ID && range.fromSeq >= 1 && range.toSeq <= c3.ledger_seq)).toBe(true);
  });
});
