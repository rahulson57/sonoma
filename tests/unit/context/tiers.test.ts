/**
 * SPEC-008 Tiers: Tier 1 state and Tier 2 workspace commit are present in every ResumeContext, whatever the budget,
 * the ledger size, the lineage position or the entry point (resume or handoff).
 */
import { describe, expect, it } from 'vitest';
import { createContextBuilder, intentGroup, isContextError, type RestoredCheckpointInput, type ResumeContext } from '../../../src/context/index.js';
import type { Checkpoint, LedgerEvent } from '../../../src/model/types.js';
import { validateAgentState } from '../../../src/model/validate.js';
import {
  MemoryStorage,
  WORKTREE,
  checkpointAt,
  claim,
  contextChars,
  fakeGit,
  renderedList,
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

function expectTiers(context: ResumeContext, restored: RestoredCheckpointInput, checkpoint: Checkpoint): void {
  // Tier 1: the restored state, pending_intent narrowed to retained intents of the rendered list, in its order.
  const { pending_intent: listed, ...stateRest } = context.state;
  const { pending_intent: _recorded, ...restoredRest } = restored.state;
  expect(stateRest).toEqual(restoredRest);
  expect(validateAgentState(context.state).ok).toBe(true);
  const source = renderedList(restored);
  const listedIds = new Set(listed.map((intent) => intent.request_event_id));
  expect(listed).toEqual(source.filter((intent) => listedIds.has(intent.request_event_id)));
  expect(listed).toEqual(expect.arrayContaining(source.filter((intent) => intentGroup(intent) === 'never_dropped')));
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

    expectTiers(context, restored, c2);
    // A short run loses nothing to the Tier 1 bound.
    expect(context.state).toEqual(restored.state);
    expect(context.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    expect(git.calls).toEqual([[c1.workspace_commit, c2.workspace_commit]]);
    expect(sectionLines(context.systemPreamble, `changed paths since parent c_1 (${c1.workspace_commit})`)).toEqual(['  - M src/app.ts', '  - A src/new.ts']);
    expect(sectionLines(context.systemPreamble, 'goal')[0]).toBe('  - Ship the resume demo');
    expect(sectionLines(context.systemPreamble, 'next_action')[0]).toBe('  - Run the test suite');
    expect(sectionLines(context.systemPreamble, 'completed')).toEqual([expect.stringContaining('tool call_1')]);
    expect(context.systemPreamble).toContain(`workspace path: ${WORKTREE}`);
    expect(context.systemPreamble).toContain(`semantic state source: this checkpoint (${c2.run_id}:c_2)`);
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

    expectTiers(tight, restored, c2);
    expect(tight.hydratedEvents).toEqual([]);
    expect(tight.tokenEstimate).toBe(tiersOnly);
  });

  it('includes both tiers for a run’s first checkpoint, which has no parent to diff against', async () => {
    const { events, c1 } = smallRun();
    const git = fakeGit();
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1]), git });
    const restored = restoredAt(c1, events);

    const context = await builder.buildResumeContext(restored);

    expectTiers(context, restored, c1);
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

    expectTiers(context, restored, c2);
    expect(context.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    // Bounded tool intents go ahead of Tier 3 (DEC-034(2)), so at 2000 Tier 3 may be empty.
    if (maxTokens > 2000) expect(context.hydratedEvents.length).toBeGreaterThan(0);
  });

  it('includes both tiers in a handoff context and names the target agent', async () => {
    const { events, c1, c2 } = smallRun();
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [c1, c2]), git: fakeGit() });
    const restored = restoredAt(c2, events);

    const withModel = await builder.buildHandoffContext(restored, { harness: 'codex', model: 'gpt-5' });
    expectTiers(withModel, restored, c2);
    expect(withModel.tokenEstimate).toBeLessThanOrEqual(8000);
    expect(withModel.systemPreamble).toContain('## Handoff\ntarget harness: codex\ntarget model: gpt-5');

    const withoutModel = await builder.buildHandoffContext(restored, { harness: 'claude-code' });
    expectTiers(withoutModel, restored, c2);
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
