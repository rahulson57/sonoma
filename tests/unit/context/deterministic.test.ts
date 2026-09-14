/**
 * SPEC-008 "Resume is deterministic": same checkpoint + same maxTokens → byte-identical ResumeContext, independent
 * of the wall clock, of which builder instance runs, and of the member order of the objects it is given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContextBuilder, type ContextBuilder, type RestoredCheckpointInput } from '../../../src/context/index.js';
import type { Checkpoint, LedgerEvent, SemanticClaim } from '../../../src/model/types.js';
import { MemoryStorage, checkpointAt, claim, fakeGit, restoredAt, sealFakeLedger, staticClaims } from './support.js';

/** A deep copy whose object members are inserted in reverse order. */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => reversedKeys(item)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reversedKeys(member)])) as T;
  }
  return value;
}

const events = sealFakeLedger(3000, 11);
const runId = events[0]?.run_id ?? '';
const c1 = checkpointAt({ n: 1, ledgerSeq: 1000, runId });
const c2 = checkpointAt({ n: 2, ledgerSeq: 2500, parent: c1 });
const changes = { [`${c1.workspace_commit}..${c2.workspace_commit}`]: [{ status: 'M', path: 'src/b.ts' }, { status: 'R100', path: 'src/new.ts', oldPath: 'src/old.ts' }, { status: 'A', path: 'src/a.ts' }] };
const claims: SemanticClaim[] = [
  claim('goal', 'Make resume deterministic', [events[20]?.event_id ?? '']),
  claim('assumption', 'The fake ledger is representative', [events[1500]?.event_id ?? '', events[2400]?.event_id ?? '']),
];

function fixture(options: { reorder: boolean }): { builder: ContextBuilder; restored: RestoredCheckpointInput } {
  const shape = <T>(value: T): T => (options.reorder ? reversedKeys(value) : value);
  const storedEvents: LedgerEvent[] = shape(events);
  const checkpoints: Checkpoint[] = shape([c1, c2]);
  const builder = createContextBuilder({
    storage: new MemoryStorage(storedEvents, checkpoints),
    git: fakeGit(shape(changes)),
    claims: staticClaims(shape(claims)),
  });
  return { builder, restored: shape(restoredAt(c2, events)) };
}

describe('deterministic', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([2000, 8000, 32000])('building twice from the same checkpoint with maxTokens %i yields byte-identical JSON', async (maxTokens) => {
    const first = fixture({ reorder: false });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const a = JSON.stringify(await first.builder.buildResumeContext(first.restored, { maxTokens }));

    const second = fixture({ reorder: true });
    vi.setSystemTime(Date.UTC(2031, 6, 9, 23, 59, 59));
    const b = JSON.stringify(await second.builder.buildResumeContext(second.restored, { maxTokens }));

    const c = JSON.stringify(await first.builder.buildResumeContext(first.restored, { maxTokens }));

    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(JSON.parse(a)).toMatchObject({ workspaceCommit: c2.workspace_commit });
  });

  it('handoff contexts are byte-identical for the same checkpoint and target', async () => {
    const first = fixture({ reorder: false });
    const second = fixture({ reorder: true });
    const target = { harness: 'codex', model: 'gpt-5' };

    const a = JSON.stringify(await first.builder.buildHandoffContext(first.restored, target));
    const b = JSON.stringify(await second.builder.buildHandoffContext(second.restored, reversedKeys(target)));

    expect(b).toBe(a);
  });

  it('lists changed paths in a fixed order whatever order git reports them in', async () => {
    const context = await fixture({ reorder: false }).builder.buildResumeContext(fixture({ reorder: false }).restored);
    const listed = context.systemPreamble.split('\n').filter((line) => /^ {2}- (A|M|R100) /.test(line));
    expect(listed).toEqual(['  - A src/a.ts', '  - M src/b.ts', '  - R100 src/old.ts -> src/new.ts']);
  });
});
