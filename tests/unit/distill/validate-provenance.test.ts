/**
 * SPEC-007: a claim with empty provenance, or citing an event id outside ledgerRange, is dropped whole and
 * counted in rejectedClaims; the projection still persists with the remaining claims.
 */
import { describe, expect, it } from 'vitest';
import { distill, validateClaims } from '../../../src/distill/index.js';
import { depsFor, fakeRun, provenance, reply, spyProvider } from './support.js';

/** Checkpoint c_2 covers seq (20, 40] of a 60-event run. */
const RUN = { events: 60, prevCursor: 20, cursor: 40 } as const;

describe('distill() provenance validation', () => {
  it('persists the projection with a claim whose provenance is empty dropped, and counts it', async () => {
    const run = await fakeRun(RUN);
    const good = { field: 'goal', value: 'Ship the distiller', confidence: 0.9, provenance: provenance({ event_ids: [run.events[29]!.event_id] }) };
    const empty = { field: 'assumption', value: 'Nobody reads the ledger', provenance: provenance({}) };
    const deps = depsFor(run, spyProvider(reply([good, empty])));

    const result = await distill(run.request, deps);

    expect(result.rejectedClaims).toBe(1);
    const stored = await deps.store.get(result.projection.id);
    expect(stored).toEqual(result.projection);
    expect(stored.claims).toEqual([{ ...good, origin: 'distilled' }]);
  });

  it('persists the projection with claims citing event ids outside (prevCursor, cursor] dropped, and counts them', async () => {
    const run = await fakeRun(RUN);
    const cite = (seq: number, value: string) => ({ field: 'decision', value, provenance: provenance({ event_ids: [run.events[seq - 1]!.event_id] }) });
    const claims = [
      cite(10, 'before the previous checkpoint'),
      cite(20, 'the previous cursor itself (exclusive)'),
      cite(21, 'first event of the delta'),
      cite(40, 'this cursor (inclusive)'),
      cite(50, 'after this checkpoint'),
    ];
    const deps = depsFor(run, spyProvider(reply(claims)));

    const result = await distill(run.request, deps);

    expect(result.rejectedClaims).toBe(3);
    const stored = await deps.store.get(result.projection.id);
    expect(stored.claims.map((claim) => claim.value)).toEqual(['first event of the delta', 'this cursor (inclusive)']);
    for (const claim of stored.claims) {
      for (const id of claim.provenance.event_ids) {
        const seq = run.events.find((event) => event.event_id === id)!.seq;
        expect(seq > RUN.prevCursor && seq <= RUN.cursor).toBe(true);
      }
    }
  });

  it('drops a claim whole when only part of its evidence is out of range', async () => {
    const run = await fakeRun(RUN);
    const mixed = { field: 'plan', value: 'x', provenance: provenance({ event_ids: [run.events[29]!.event_id, run.events[4]!.event_id] }) };
    const deps = depsFor(run, spyProvider(reply([mixed])));

    const result = await distill(run.request, deps);

    expect(result.rejectedClaims).toBe(1);
    expect((await deps.store.get(result.projection.id)).claims).toEqual([]);
  });

  it('accepts the state blob as artifact evidence and a checkpoint of the run', async () => {
    const run = await fakeRun(RUN);
    const claim = { field: 'current_state', value: 'y', provenance: provenance({ artifact_refs: [run.request.stateHash], checkpoint_ids: ['c_1'] }) };
    const result = await distill(run.request, depsFor(run, spyProvider(reply([claim]))));

    expect(result.rejectedClaims).toBe(0);
    expect(result.projection.claims).toEqual([{ ...claim, origin: 'distilled' }]);
  });
});

describe('validateClaims()', () => {
  const context = {
    eventIds: new Set(['evt_a']),
    artifactRefs: new Set(['f'.repeat(64)]),
    hasCheckpoint: async (id: string) => id === 'c_1',
  };
  const base = { field: 'plan', value: 'x', provenance: provenance({ event_ids: ['evt_a'] }) };

  it.each<[string, unknown]>([
    ['a non-object', 'nope'],
    ['a field SPEC-007 does not list (current_step)', { ...base, field: 'current_step' }],
    ['a deterministic field', { ...base, field: 'workspace_commit' }],
    ['a non-string value', { ...base, value: 42 }],
    ['a confidence above 1', { ...base, confidence: 1.5 }],
    ['no provenance', { field: 'plan', value: 'x' }],
    ['all provenance lists empty', { ...base, provenance: provenance({}) }],
    ['a provenance list that is not an array', { ...base, provenance: { event_ids: 'evt_a' } }],
    ['an empty evidence entry', { ...base, provenance: provenance({ event_ids: ['evt_a', ''] }) }],
    ['an event id not in the range', { ...base, provenance: provenance({ event_ids: ['evt_b'] }) }],
    ['an artifact not among the inputs', { ...base, provenance: provenance({ artifact_refs: ['e'.repeat(64)] }) }],
    ['a checkpoint not in the store', { ...base, provenance: provenance({ checkpoint_ids: ['c_9'] }) }],
    ['a workspace path escaping the commit', { ...base, provenance: provenance({ workspace_paths: ['../secrets.txt'] }) }],
    ['an absolute workspace path', { ...base, provenance: provenance({ workspace_paths: ['/etc/passwd'] }) }],
  ])('rejects %s', async (_label, candidate) => {
    await expect(validateClaims([candidate], context)).resolves.toEqual({ claims: [], rejectedClaims: 1 });
  });

  it('keeps valid claims, forces origin to distilled and drops unknown members', async () => {
    const result = await validateClaims(
      [
        { ...base, origin: 'human', extra: true },
        { field: 'next_action', value: 'y', provenance: { workspace_paths: ['src/a.ts'], checkpoint_ids: ['c_1'] } },
        { field: 'decision', value: 'z', confidence: 0, provenance: provenance({ artifact_refs: ['f'.repeat(64)] }) },
      ],
      context,
    );

    expect(result.rejectedClaims).toBe(0);
    expect(result.claims.map((claim) => claim.origin)).toEqual(['distilled', 'distilled', 'distilled']);
    expect(result.claims[0]).not.toHaveProperty('extra');
    expect(result.claims[1]!.provenance).toEqual({ event_ids: [], artifact_refs: [], workspace_paths: ['src/a.ts'], checkpoint_ids: ['c_1'] });
  });
});
