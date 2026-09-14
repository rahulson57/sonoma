/**
 * SPEC-008 Tiers: Tier 1 state and Tier 2 workspace commit are present in every ResumeContext, whatever the budget,
 * the ledger size, the lineage position or the entry point (resume or handoff).
 */
import { describe, expect, it } from 'vitest';
import { createContextBuilder, isContextError, renderedStatus, type ResumeContext } from '../../../src/context/index.js';
import type { AgentStateObject, Checkpoint, LedgerEvent, PendingIntent } from '../../../src/model/types.js';
import { validateAgentState } from '../../../src/model/validate.js';
import {
  MemoryStorage,
  WORKTREE,
  checkpointAt,
  claim,
  contextChars,
  fakeGit,
  restoredAt,
  sealEvents,
  sealFakeLedger,
  sectionLines,
  staticClaims,
  type Draft,
} from './support.js';

function smallRun(): { events: LedgerEvent[]; c1: Checkpoint; c2: Checkpoint } {
  const drafts: Draft[] = [
    { type: 'run.created', payload: { agent: 'claude-code' } },
    { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_1', tool: 'Read', input: { path: 'src/app.ts' } } },
    { type: 'tool.completed', payload: { tool_call_id: 'call_1', exit_code: 0 } },
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } },
    { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_2', tool: 'Edit', input: { path: 'src/app.ts' } } },
    { type: 'workspace.changed', payload: { paths: ['src/app.ts', 'src/new.ts'] } },
    { type: 'checkpoint.created', payload: { checkpoint_id: 'c_2' } },
  ];
  const events = sealEvents(drafts);
  const c1 = checkpointAt({ n: 1, ledgerSeq: 4 });
  const c2 = checkpointAt({ n: 2, ledgerSeq: 7, parent: c1 });
  return { events, c1, c2 };
}

/** Unresolved intents and side effects: the ones Tier 1 may never leave out. */
function neverDropped(intents: readonly PendingIntent[]): PendingIntent[] {
  return intents.filter((intent) => intent.kind !== 'tool' || renderedStatus(intent) === 'in_progress');
}

function expectTiers(context: ResumeContext, restoredState: AgentStateObject, checkpoint: Checkpoint): void {
  // Tier 1: the checkpoint's state object, pending intent narrowed only by the Tier 1 bound.
  const { pending_intent: listed, ...stateRest } = context.state;
  const { pending_intent: recorded, ...restoredRest } = restoredState;
  expect(stateRest).toEqual(restoredRest);
  expect(validateAgentState(context.state).ok).toBe(true);
  const recordedIds = new Set(recorded.map((intent) => intent.request_event_id));
  expect(listed.every((intent) => recordedIds.has(intent.request_event_id))).toBe(true);
  expect(listed).toEqual(expect.arrayContaining(neverDropped(recorded)));
  expect(context.systemPreamble).toContain('## Tier 1 — State');
  expect(context.systemPreamble).toContain(`checkpoint: ${checkpoint.checkpoint_id}`);
  // Tier 2: the checkpoint commit.
  expect(context.workspaceCommit).toBe(checkpoint.workspace_commit);
  expect(context.systemPreamble).toContain('## Tier 2 — Workspace');
  expect(context.systemPreamble).toContain(`workspace commit: ${checkpoint.workspace_commit}`);
}

describe('Tier 1 state and Tier 2 workspace are always included', () => {
  it.each([2000, 8000, 32000])('at maxTokens %i: state, commit, changed paths and claims are present', async (maxTokens) => {
    const { events, c1, c2 } = smallRun();
    const git = fakeGit({ [`${c1.workspace_commit}..${c2.workspace_commit}`]: [{ status: 'M', path: 'src/app.ts' }, { status: 'A', path: 'src/new.ts' }] });
    const claims = staticClaims([claim('goal', 'Ship the resume demo', ['evt_000002']), claim('next_action', 'Run the test suite', ['evt_000006'])]);
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git, claims });
    const restored = restoredAt(c2, events);

    const context = await builder.buildResumeContext(restored, { maxTokens });

    expectTiers(context, restored.state, c2);
    // A short run loses nothing to the Tier 1 bound.
    expect(context.state).toEqual(restored.state);
    expect(context.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    expect(git.calls).toEqual([[c1.workspace_commit, c2.workspace_commit]]);
    expect(sectionLines(context.systemPreamble, `changed paths since parent c_1 (${c1.workspace_commit})`)).toEqual(['  - M src/app.ts', '  - A src/new.ts']);
    expect(sectionLines(context.systemPreamble, 'goal')[0]).toBe('  - Ship the resume demo');
    expect(sectionLines(context.systemPreamble, 'next_action')[0]).toBe('  - Run the test suite');
    expect(sectionLines(context.systemPreamble, 'completed')).toEqual([expect.stringContaining('tool call_1')]);
    expect(context.systemPreamble).toContain(`workspace path: ${WORKTREE}`);
    expect(claims.checkpoints).toEqual([c2]);
  });

  it('keeps Tier 1 and Tier 2 when the budget leaves no room for any Tier 3 event', async () => {
    const { events, c1, c2 } = smallRun();
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit() });
    const restored = restoredAt(c2, events);
    const roomy = await builder.buildResumeContext(restored, { maxTokens: 32000 });
    expect(roomy.hydratedEvents.length).toBeGreaterThan(0);

    const tiersOnly = Math.ceil(contextChars(roomy, []) / 4);
    const tight = await builder.buildResumeContext(restored, { maxTokens: tiersOnly });

    expectTiers(tight, restored.state, c2);
    expect(tight.hydratedEvents).toEqual([]);
    expect(tight.tokenEstimate).toBe(tiersOnly);
  });

  it('includes both tiers for a run’s first checkpoint, which has no parent to diff against', async () => {
    const { events, c1 } = smallRun();
    const git = fakeGit();
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1]), git });
    const restored = restoredAt(c1, events);

    const context = await builder.buildResumeContext(restored);

    expectTiers(context, restored.state, c1);
    expect(context.systemPreamble).toContain('changed paths since parent: not listed (no parent checkpoint in this run)');
    expect(git.calls).toEqual([]);
    for (const heading of ['goal', 'plan', 'decisions', 'assumptions', 'next_action']) {
      expect(sectionLines(context.systemPreamble, heading)).toEqual(['  - none recorded']);
    }
  });

  it.each([2000, 8000, 32000])('includes both tiers over a 5,000-event ledger at maxTokens %i', async (maxTokens) => {
    const events = sealFakeLedger(5000, 3);
    const runId = events[0]?.run_id ?? '';
    const c1 = checkpointAt({ n: 1, ledgerSeq: 2000, runId });
    const c2 = checkpointAt({ n: 2, ledgerSeq: 4500, parent: c1 });
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit() });
    const restored = restoredAt(c2, events);

    const context = await builder.buildResumeContext(restored, { maxTokens });

    expectTiers(context, restored.state, c2);
    expect(context.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    expect(context.hydratedEvents.length).toBeGreaterThan(0);
  });

  it('bounds resolved tool intents newest first, keeps every unresolved and side-effect intent, and counts what it leaves out', async () => {
    const events = sealFakeLedger(5000, 3);
    const runId = events[0]?.run_id ?? '';
    const checkpoint = checkpointAt({ n: 1, ledgerSeq: 4500, runId });
    const base = restoredAt(checkpoint, events);
    const requestAt = (seq: number): string => events[seq - 1]?.event_id ?? '';
    const sideEffects: PendingIntent[] = [
      { kind: 'side_effect', intent_id: 'se_email', request_event_id: requestAt(3), status: 'completed', requested_seq: 3, resolved_seq: 4 },
      { kind: 'side_effect', intent_id: 'se_deploy', request_event_id: requestAt(5), status: 'in_progress', requested_seq: 5, resolved_seq: null },
    ];
    const recorded = [...sideEffects, ...base.state.pending_intent];
    const restored = { ...base, state: { ...base.state, pending_intent: recorded } };
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });

    const context = await builder.buildResumeContext(restored, { maxTokens: 2000 });

    expectTiers(context, restored.state, checkpoint);
    expect(context.tokenEstimate).toBeLessThanOrEqual(2000);
    const listed = context.state.pending_intent;
    expect(listed).toEqual(expect.arrayContaining(sideEffects));

    const resolvedTools = recorded
      .filter((intent) => intent.kind === 'tool' && renderedStatus(intent) !== 'in_progress')
      .sort((a, b) => a.requested_seq - b.requested_seq);
    const listedTools = listed.filter((intent) => intent.kind === 'tool' && renderedStatus(intent) !== 'in_progress');
    expect(listedTools.length).toBeGreaterThan(0);
    expect(listedTools.length).toBeLessThan(resolvedTools.length);
    // Exactly the newest resolved tool intents.
    expect(listedTools.map((intent) => intent.request_event_id)).toEqual(resolvedTools.slice(-listedTools.length).map((intent) => intent.request_event_id));

    const omittedCompleted = Number(/ {2}- (\d+) earlier completed tool actions omitted/.exec(context.systemPreamble)?.[1] ?? 0);
    const omittedFailed = Number(/ {2}- (\d+) earlier failed tool actions omitted/.exec(context.systemPreamble)?.[1] ?? 0);
    expect(omittedCompleted + omittedFailed + listedTools.length).toBe(resolvedTools.length);
    expect(sectionLines(context.systemPreamble, 'completed').some((line) => line.includes('se_email'))).toBe(true);
    expect(sectionLines(context.systemPreamble, 'in_progress').some((line) => line.includes('se_deploy'))).toBe(true);
  });

  it('includes both tiers in a handoff context and names the target agent', async () => {
    const { events, c1, c2 } = smallRun();
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit() });
    const restored = restoredAt(c2, events);

    const withModel = await builder.buildHandoffContext(restored, { harness: 'codex', model: 'gpt-5' });
    expectTiers(withModel, restored.state, c2);
    expect(withModel.tokenEstimate).toBeLessThanOrEqual(8000);
    expect(withModel.systemPreamble).toContain('## Handoff\ntarget harness: codex\ntarget model: gpt-5');

    const withoutModel = await builder.buildHandoffContext(restored, { harness: 'claude-code' });
    expectTiers(withoutModel, restored.state, c2);
    expect(withoutModel.systemPreamble).toContain('target harness: claude-code\ntarget model: unspecified');

    for (const bad of [{ harness: '' }, { harness: 'codex', model: '' }, null]) {
      const error = await builder.buildHandoffContext(restored, bad as never).catch((err: unknown) => err);
      expect(isContextError(error, 'ERR_INVALID_INPUT')).toBe(true);
    }
  });

  it('accepts SPEC-008’s input names and rejects inputs that do not describe one checkpoint', async () => {
    const { events, c1, c2 } = smallRun();
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit() });
    const engineShape = restoredAt(c2, events);
    const specShape = { checkpoint: c2, state: engineShape.state, workspacePath: WORKTREE, ledgerCursor: c2.ledger_seq };

    expect(JSON.stringify(await builder.buildResumeContext(specShape))).toBe(JSON.stringify(await builder.buildResumeContext(engineShape)));

    const rejects = [
      { ...specShape, ledgerCursor: c2.ledger_seq + 1 },
      { ...specShape, state: restoredAt(c1, events).state },
      { ...specShape, worktreePath: '/elsewhere' },
      { ...specShape, checkpoint: { ...c2, workspace_commit: 'not-a-sha' } },
    ];
    for (const input of rejects) {
      const error = await builder.buildResumeContext(input).catch((err: unknown) => err);
      expect(isContextError(error, 'ERR_INVALID_INPUT')).toBe(true);
    }
  });
});
