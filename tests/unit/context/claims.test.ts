/**
 * DEC-036(1): Tier 1 claims come from the nearest checkpoint on the restored checkpoint's lineage that has any
 * (itself → parents → across a fork), using its newest projection's claims plus its agent_declared claims. Never a
 * sibling or an abandoned branch. The preamble names the source, or says no semantic state is recorded. Claims other
 * than goal / current_step / next_action are dropped whole when they do not fit.
 */
import { describe, expect, it } from 'vitest';
import { NO_SEMANTIC_STATE, createContextBuilder, isContextError, type ClaimSource } from '../../../src/context/index.js';
import type { Checkpoint, LedgerEvent } from '../../../src/model/types.js';
import {
  MemoryStorage,
  RUN_ID,
  checkpointAt,
  claim,
  claimTable,
  fakeGit,
  keyOf,
  projectionOf,
  restoredAt,
  sealEvents,
  sectionLines,
  staticClaims,
  type Draft,
} from './support.js';

const RUN_A = RUN_ID;
const RUN_B = `run_${'0'.repeat(25)}B`;

const a1 = checkpointAt({ n: 1, ledgerSeq: 4 });
const a2 = checkpointAt({ n: 2, ledgerSeq: 6, parent: a1 });
const a3 = checkpointAt({ n: 3, ledgerSeq: 9, parent: a1 });
const a4 = checkpointAt({ n: 4, ledgerSeq: 10, parent: a3 });
const eventsA = sealEvents(
  [
    { type: 'run.created', payload: { agent: 'claude-code' } }, // 1
    { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_1', tool: 'Read' } }, // 2
    { type: 'tool.completed', payload: { tool_call_id: 'call_1' } }, // 3
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }, // 4 = a1
    { type: 'workspace.changed', payload: { paths: ['src/abandoned.ts'] } }, // 5
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_2' } }, // 6 = a2
    { type: 'agent.resumed', payload: { checkpoint_id: 'c_1', ledger_seq: 4, workspace_commit: a1.workspace_commit } }, // 7: c_2 is now a sibling branch
    { type: 'workspace.changed', payload: { paths: ['src/kept.ts'] } }, // 8
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_3' } }, // 9 = a3 (parent c_1)
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_4' } }, // 10 = a4 (parent c_3)
  ],
  RUN_A,
);

function forkedRun(forkPayload: Readonly<Record<string, unknown>>): LedgerEvent[] {
  const drafts: Draft[] = [
    { type: 'agent.forked', payload: forkPayload }, // 1
    { type: 'workspace.changed', payload: { paths: ['src/fork.ts'] } }, // 2
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }, // 3 = b1
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_2' } }, // 4 = b2
  ];
  return sealEvents(drafts, RUN_B);
}

const forkOfA2 = { parent_run_id: RUN_A, forked_from_checkpoint: 'c_2', ledger_seq: a2.ledger_seq, workspace_commit: a2.workspace_commit };
const eventsB = forkedRun(forkOfA2);
const b1 = checkpointAt({ n: 1, ledgerSeq: 3, runId: RUN_B });
const b2 = checkpointAt({ n: 2, ledgerSeq: 4, parent: b1 });
const checkpoints = [a1, a2, a3, a4, b1, b2];

function evtA(seq: number): string {
  return eventsA[seq - 1]?.event_id ?? '';
}

function builderWith(claims: ClaimSource | undefined, options: { events?: readonly LedgerEvent[]; git?: ReturnType<typeof fakeGit> } = {}): ReturnType<typeof createContextBuilder> {
  const storage = new MemoryStorage(options.events ?? [...eventsA, ...eventsB], checkpoints);
  return createContextBuilder({ storage, git: options.git ?? fakeGit(), ...(claims === undefined ? {} : { claims }) });
}

function restoredOf(checkpoint: Checkpoint): ReturnType<typeof restoredAt> {
  return restoredAt(checkpoint, checkpoint.run_id === RUN_A ? eventsA : eventsB);
}

describe('claim selection by lineage', () => {
  it('uses the nearest earlier checkpoint with claims: its newest projection plus its declared claims, never an abandoned sibling', async () => {
    const source = claimTable({
      [keyOf(a1)]: {
        projections: [[claim('goal', 'Old goal', [evtA(3)])], [claim('goal', 'Ship v1', [evtA(3)])]],
        declared: [claim('next_action', 'Run the tests', [evtA(2)], 'agent_declared')],
      },
      [keyOf(a2)]: { projections: [[claim('goal', 'Abandoned branch goal', [evtA(5)])]] },
    });

    const context = await builderWith(source).buildResumeContext(restoredOf(a4), { maxTokens: 8000 });

    expect(source.asked).toEqual([keyOf(a4), keyOf(a3), keyOf(a1)]);
    const preamble = context.systemPreamble;
    expect(preamble).toContain(`semantic state source: checkpoint ${RUN_A}:c_1 (ledger cursor seq 4), the nearest earlier checkpoint on this lineage with recorded claims.`);
    expect(sectionLines(preamble, 'goal')[0]).toBe('  - Ship v1');
    expect(sectionLines(preamble, 'next_action')[0]).toBe('  - Run the tests');
    expect(sectionLines(preamble, 'next_action')[1]).toContain('origin agent_declared');
    expect(preamble).not.toContain('Old goal');
    expect(preamble).not.toContain('Abandoned branch goal');
    // Both cited events (next_action → seq 2, goal → seq 3) are on the lineage and in this run: hydrated first, seq ascending.
    expect(context.hydratedEvents.slice(0, 2).map((event) => event.seq)).toEqual([2, 3]);
    expect(context.hydratedEvents.map((event) => event.seq)).not.toContain(5);
  });

  it('a checkpoint with its own claims is its own source', async () => {
    const source = claimTable({ [keyOf(a2)]: { projections: [[claim('goal', 'Explore the alternative', [evtA(5)])]] } });

    const context = await builderWith(source).buildResumeContext(restoredOf(a2));

    expect(source.asked).toEqual([keyOf(a2)]);
    expect(context.systemPreamble).toContain(`semantic state source: this checkpoint (${RUN_A}:c_2)`);
    expect(sectionLines(context.systemPreamble, 'goal')[0]).toBe('  - Explore the alternative');
  });

  it('crosses a fork to the checkpoint the run was forked from, then to that checkpoint’s parents', async () => {
    const atForkSource = claimTable({ [keyOf(a2)]: { projections: [[claim('goal', 'Before the fork', [evtA(5)])]] } });
    const context = await builderWith(atForkSource).buildResumeContext(restoredOf(b2));

    expect(atForkSource.asked).toEqual([keyOf(b2), keyOf(b1), keyOf(a2)]);
    expect(context.systemPreamble).toContain(`semantic state source: checkpoint ${RUN_A}:c_2 (ledger cursor seq 6)`);
    expect(context.systemPreamble).toContain(`That checkpoint is in run ${RUN_A}, which this run descends from by fork`);
    expect(sectionLines(context.systemPreamble, 'goal')[0]).toBe('  - Before the fork');
    // Claims from another run cite that run's ledger, which is not read: only this run's delta (3, 4] is hydrated.
    expect(context.hydratedEvents.map((event) => `${event.run_id}#${event.seq}`)).toEqual([`${RUN_B}#4`]);

    const aboveForkSource = claimTable({
      [keyOf(a1)]: { projections: [[claim('goal', 'Root goal', [evtA(3)])]] },
      [keyOf(a3)]: { projections: [[claim('goal', 'Sibling after resume', [evtA(8)])]] },
    });
    const deeper = await builderWith(aboveForkSource).buildResumeContext(restoredOf(b2));

    expect(aboveForkSource.asked).toEqual([keyOf(b2), keyOf(b1), keyOf(a2), keyOf(a1)]);
    expect(sectionLines(deeper.systemPreamble, 'goal')[0]).toBe('  - Root goal');
    expect(deeper.systemPreamble).not.toContain('Sibling after resume');
  });

  it('says no semantic state is recorded when no checkpoint on the lineage has claims', async () => {
    const empty = claimTable({});
    const context = await builderWith(empty).buildResumeContext(restoredOf(b2));

    expect(empty.asked).toEqual([keyOf(b2), keyOf(b1), keyOf(a2), keyOf(a1)]);
    expect(context.systemPreamble).toContain(`semantic state source: none (${NO_SEMANTIC_STATE} on this checkpoint's lineage)`);
    for (const heading of ['goal', 'plan', 'current_step', 'decisions', 'assumptions', 'next_action']) {
      expect(sectionLines(context.systemPreamble, heading)).toEqual(['  - none recorded']);
    }

    const withoutSource = await builderWith(undefined).buildResumeContext(restoredOf(a4));
    expect(withoutSource.systemPreamble).toContain(NO_SEMANTIC_STATE);
  });

  it('lists the paths a forked run’s first checkpoint changed since its fork source (Tier 2)', async () => {
    const git = fakeGit({ [`${a2.workspace_commit}..${b1.workspace_commit}`]: [{ status: 'A', path: 'src/fork.ts' }] });

    const context = await builderWith(undefined, { git }).buildResumeContext(restoredOf(b1));

    expect(git.calls).toEqual([[a2.workspace_commit, b1.workspace_commit]]);
    expect(sectionLines(context.systemPreamble, `changed paths since fork source ${RUN_A}:c_2 (${a2.workspace_commit})`)).toEqual(['  - A src/fork.ts']);
    expect(context.workspaceCommit).toBe(b1.workspace_commit);
  });

  it('refuses claim records and fork events that do not describe the checkpoint asked about (ERR_CORRUPT)', async () => {
    const wrongCheckpoint: ClaimSource = { claimsAt: async () => ({ projections: [projectionOf(a1, [claim('goal', 'x', [evtA(3)])])], declared: [] }) };
    const wrongOrigin: ClaimSource = { claimsAt: async () => ({ projections: [], declared: [claim('goal', 'x', [evtA(3)], 'distilled')] }) };
    const notARecord = { claimsAt: async () => [claim('goal', 'x', [evtA(3)])] } as unknown as ClaimSource;
    for (const source of [wrongCheckpoint, wrongOrigin, notARecord]) {
      const error = await builderWith(source)
        .buildResumeContext(restoredOf(a2))
        .catch((err: unknown) => err);
      expect(isContextError(error, 'ERR_CORRUPT')).toBe(true);
    }

    const mismatchedFork = forkedRun({ ...forkOfA2, ledger_seq: a2.ledger_seq + 1 });
    const error = await builderWith(undefined, { events: [...eventsA, ...mismatchedFork] })
      .buildResumeContext(restoredAt(b1, mismatchedFork))
      .catch((err: unknown) => err);
    expect(isContextError(error, 'ERR_CORRUPT')).toBe(true);
  });
});

describe('claims under the budget', () => {
  it('drops claims other than goal / current_step / next_action whole when they do not fit, and counts them exactly', async () => {
    const assumptions = Array.from({ length: 40 }, (_, i) => claim('assumption', `Assumption ${String(i).padStart(2, '0')}: ${'the index stays consistent '.repeat(4)}`, [evtA(2)]));
    const claims = [claim('goal', 'Ship the resume demo', [evtA(2)]), ...assumptions];
    const builder = builderWith(staticClaims(claims));

    const tight = await builder.buildResumeContext(restoredOf(a1), { maxTokens: 2000 });

    expect(tight.tokenEstimate).toBeLessThanOrEqual(2000);
    expect(sectionLines(tight.systemPreamble, 'goal')[0]).toBe('  - Ship the resume demo');
    const lines = sectionLines(tight.systemPreamble, 'assumptions');
    const shown = lines.filter((line) => line.startsWith('  - Assumption'));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(40);
    // Whole claims in claim order, each with its evidence line.
    expect(shown).toEqual(assumptions.slice(0, shown.length).map((assumption) => `  - ${assumption.value}`));
    expect(lines.filter((line) => line.startsWith('    (origin distilled;'))).toHaveLength(shown.length);
    expect(lines.at(-1)).toBe(`  - ${40 - shown.length} more claims omitted: they do not fit the token budget`);

    const roomy = await builder.buildResumeContext(restoredOf(a1), { maxTokens: 32000 });
    expect(sectionLines(roomy.systemPreamble, 'assumptions').filter((line) => line.startsWith('  - Assumption'))).toHaveLength(40);
    expect(roomy.systemPreamble).not.toContain('more claims omitted');
  });

  it('never drops goal, current_step or next_action claims: ERR_BUDGET when they alone do not fit', async () => {
    const nextActions = Array.from({ length: 60 }, (_, i) => claim('next_action', `Step ${i}: ${'then verify the result carefully '.repeat(6)}`, [evtA(2)]));

    const error = await builderWith(staticClaims(nextActions))
      .buildResumeContext(restoredOf(a1), { maxTokens: 2000 })
      .catch((err: unknown) => err);

    expect(isContextError(error, 'ERR_BUDGET')).toBe(true);
  });
});
