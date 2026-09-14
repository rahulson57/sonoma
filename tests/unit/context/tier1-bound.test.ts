/**
 * DEC-034: the Tier 1 pending-intent bound.
 * - Never dropped: every in-progress intent and every side-effect intent.
 * - Bounded: failed (status pending) then completed tool intents, newest first, at most 20 per group, each whole.
 * - state.pending_intent is exactly the retained intents of the rendered list, in that list's order.
 * - ERR_BUDGET only when the never-dropped set alone does not fit.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETED_TOOL_INTENT_CAP,
  IN_PROGRESS_NOTICE,
  PENDING_TOOL_INTENT_CAP,
  createContextBuilder,
  intentGroup,
  isContextError,
  type IntentGroup,
} from '../../../src/context/index.js';
import { abandonedWindows, pendingIntentAt } from '../../../src/engine/resume-intent.js';
import type { LedgerEvent, PendingIntent } from '../../../src/model/types.js';
import { validateAgentState } from '../../../src/model/validate.js';
import { MemoryStorage, checkpointAt, contextChars, fakeGit, omittedCount, restoredAt, sealEvents, sealFakeLedger, sectionLines, type Draft } from './support.js';

function toolRun(): LedgerEvent[] {
  const drafts: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
  let failures = 0;
  for (let i = 1; i <= 55; i += 1) {
    const id = `call_${String(i).padStart(2, '0')}`;
    drafts.push({ type: 'tool.requested', actor: 'agent', payload: { tool_call_id: id, tool: 'Bash' } });
    // 25 failures interleaved with 30 completions.
    const fails = i % 2 === 0 && failures < 25;
    if (fails) failures += 1;
    drafts.push(fails ? { type: 'tool.failed', payload: { tool_call_id: id, error: 'exit 1' } } : { type: 'tool.completed', payload: { tool_call_id: id, exit_code: 0 } });
  }
  drafts.push({ type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_open', tool: 'Edit' } });
  drafts.push({ type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: 'se_sent', target: 'mailto:ops@example.invalid' } });
  drafts.push({ type: 'side_effect.committed', payload: { side_effect_id: 'se_sent' } });
  drafts.push({ type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: 'se_deploy', target: 'https://deploy.example.invalid' } });
  drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } });
  return sealEvents(drafts);
}

/** A budget at which the failed-first fixture below lists some, but not all, of its failed tool intents. */
const PARTIAL_BOUNDED_TOKENS = 1200;

function inGroup(intents: readonly PendingIntent[], group: IntentGroup): PendingIntent[] {
  return intents.filter((intent) => intentGroup(intent) === group);
}

function newest(intents: readonly PendingIntent[], group: IntentGroup, n: number): PendingIntent[] {
  return inGroup(intents, group)
    .sort((a, b) => b.requested_seq - a.requested_seq)
    .slice(0, n);
}

describe('Tier 1 pending-intent bound (DEC-034)', () => {
  it('exports caps of 20 per bounded group', () => {
    expect(PENDING_TOOL_INTENT_CAP).toBe(20);
    expect(COMPLETED_TOOL_INTENT_CAP).toBe(20);
  });

  it('keeps exactly the newest 20 failed and 20 completed tool intents at 32000, every never-dropped intent, and counts the rest', async () => {
    const events = toolRun();
    const checkpoint = checkpointAt({ n: 1, ledgerSeq: events.length });
    const restored = restoredAt(checkpoint, events);
    const recorded = restored.state.pending_intent;
    expect(inGroup(recorded, 'completed')).toHaveLength(30);
    expect(inGroup(recorded, 'pending')).toHaveLength(25);
    expect(inGroup(recorded, 'never_dropped')).toHaveLength(3);

    const context = await createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() }).buildResumeContext(restored, {
      maxTokens: 32000,
    });

    const keep = new Set([...inGroup(recorded, 'never_dropped'), ...newest(recorded, 'pending', 20), ...newest(recorded, 'completed', 20)]);
    // The retained intents, in the recorded order.
    expect(context.state.pending_intent).toEqual(recorded.filter((intent) => keep.has(intent)));
    expect(validateAgentState(context.state).ok).toBe(true);
    expect(omittedCount(context.systemPreamble, 'completed tool actions')).toBe(10);
    expect(omittedCount(context.systemPreamble, 'failed tool actions')).toBe(5);

    const completed = sectionLines(context.systemPreamble, 'completed');
    const inProgress = sectionLines(context.systemPreamble, 'in_progress');
    const failed = sectionLines(context.systemPreamble, 'pending');
    expect(completed.filter((line) => line.includes(': acknowledged at seq'))).toHaveLength(20 + 1);
    expect(completed.some((line) => line.includes('side_effect se_sent'))).toBe(true);
    expect(failed.filter((line) => line.includes('; not done'))).toHaveLength(20);
    expect(inProgress.find((line) => line.includes('tool call_open'))).toContain(IN_PROGRESS_NOTICE);
    expect(inProgress.find((line) => line.includes('side_effect se_deploy'))).toContain(IN_PROGRESS_NOTICE);
    expect(context.tokenEstimate).toBeLessThanOrEqual(32000);
  });

  it('keeps every in-progress and side-effect intent at 2000 over a 5,000-event run, and counts every bounded intent it leaves out', async () => {
    const events = sealFakeLedger(5000, 3);
    const runId = events[0]?.run_id ?? '';
    const checkpoint = checkpointAt({ n: 1, ledgerSeq: 4500, runId });
    const base = restoredAt(checkpoint, events);
    const requestAt = (seq: number): string => events[seq - 1]?.event_id ?? '';
    const unsafe: PendingIntent[] = [
      { kind: 'side_effect', intent_id: 'se_email', request_event_id: requestAt(3), status: 'completed', requested_seq: 3, resolved_seq: 4 },
      { kind: 'side_effect', intent_id: 'se_deploy', request_event_id: requestAt(5), status: 'in_progress', requested_seq: 5, resolved_seq: null },
      { kind: 'tool', intent_id: 'tool_open', request_event_id: requestAt(7), status: 'in_progress', requested_seq: 7, resolved_seq: null },
    ];
    const recorded = [...unsafe, ...base.state.pending_intent];
    const restored = { ...base, state: { ...base.state, pending_intent: recorded } };

    const context = await createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() }).buildResumeContext(restored, {
      maxTokens: 2000,
    });

    expect(context.tokenEstimate).toBeLessThanOrEqual(2000);
    const listed = context.state.pending_intent;
    expect(inGroup(listed, 'never_dropped')).toEqual(inGroup(recorded, 'never_dropped'));
    expect(listed.slice(0, 3)).toEqual(unsafe);
    for (const [group, cap, what] of [
      ['pending', PENDING_TOOL_INTENT_CAP, 'failed tool actions'],
      ['completed', COMPLETED_TOOL_INTENT_CAP, 'completed tool actions'],
    ] as const) {
      expect(inGroup(listed, group).length).toBeLessThanOrEqual(cap);
      expect(inGroup(listed, group).length + omittedCount(context.systemPreamble, what)).toBe(inGroup(recorded, group).length);
    }
    // Subsequence of the recorded list, in its order.
    const listedIds = new Set(listed.map((intent) => intent.request_event_id));
    expect(recorded.filter((intent) => listedIds.has(intent.request_event_id))).toEqual(listed);
  });

  it('state.pending_intent equals the rendered engine list, including a side effect committed after the cursor (R4)', async () => {
    const drafts: Draft[] = [
      { type: 'run.created', payload: { agent: 'claude-code' } }, // 1
      { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_a', tool: 'Edit' } }, // 2
      { type: 'tool.completed', payload: { tool_call_id: 'call_a', exit_code: 0 } }, // 3
      { type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }, // 4 = c_1
      { type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: 'se_mail', target: 'mailto:ops@example.invalid' } }, // 5
      { type: 'side_effect.committed', payload: { side_effect_id: 'se_mail' } }, // 6
    ];
    const events = sealEvents(drafts);
    const c1 = checkpointAt({ n: 1, ledgerSeq: 4 });
    const base = restoredAt(c1, events);
    // The engine's resume(c_1) list (DEC-031): tools as of the cursor, side effects as of head.
    const pendingIntent = pendingIntentAt(events, abandonedWindows([], c1.ledger_seq, events.length));
    expect(base.state.pending_intent.map((intent) => intent.intent_id)).toEqual(['call_a']);
    expect(pendingIntent.map((intent) => intent.intent_id)).toEqual(['call_a', 'se_mail']);

    const context = await createContextBuilder({ storage: new MemoryStorage(events, [c1]), git: fakeGit() }).buildResumeContext(
      { ...base, pendingIntent },
      { maxTokens: 8000 },
    );

    expect(context.state.pending_intent).toEqual(pendingIntent);
    expect(validateAgentState(context.state).ok).toBe(true);
    const { pending_intent: _listed, ...rest } = context.state;
    const { pending_intent: _recorded, ...restoredRest } = base.state;
    expect(rest).toEqual(restoredRest);
    const mail = sectionLines(context.systemPreamble, 'completed').find((line) => line.includes('side_effect se_mail'));
    expect(mail).toContain('[recorded after this checkpoint]');
    // Nothing past the cursor is hydrated.
    expect(context.hydratedEvents.every((event) => event.seq <= c1.ledger_seq)).toBe(true);
  });

  it('skips a newer bounded tool intent that does not fit whole and lists an older, smaller one of the same group (skip-and-continue)', async () => {
    const hugeId = `call_huge_${'x'.repeat(12_000)}`;
    const events = sealEvents([
      { type: 'run.created', payload: { agent: 'claude-code' } }, // 1
      { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_small', tool: 'Bash' } }, // 2
      { type: 'tool.failed', payload: { tool_call_id: 'call_small', error: 'exit 1' } }, // 3
      { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: hugeId, tool: 'Bash' } }, // 4
      { type: 'tool.failed', payload: { tool_call_id: hugeId, error: 'exit 1' } }, // 5
      { type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }, // 6
    ]);
    const checkpoint = checkpointAt({ n: 1, ledgerSeq: events.length });
    const restored = restoredAt(checkpoint, events);
    expect(restored.state.pending_intent.map((intent) => [intent.intent_id, intentGroup(intent)])).toEqual([
      ['call_small', 'pending'],
      [hugeId, 'pending'],
    ]);
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });

    const tight = await builder.buildResumeContext(restored, { maxTokens: 2000 });

    expect(tight.tokenEstimate).toBeLessThanOrEqual(2000);
    // The newest failed intent is tried first and does not fit whole; the older, smaller one is still tried and listed.
    expect(tight.state.pending_intent.map((intent) => intent.intent_id)).toEqual(['call_small']);
    expect(sectionLines(tight.systemPreamble, 'pending').filter((line) => line.includes('; not done'))).toEqual([expect.stringContaining('tool call_small,')]);
    expect(omittedCount(tight.systemPreamble, 'failed tool actions')).toBe(1);

    const roomy = await builder.buildResumeContext(restored, { maxTokens: 32000 });
    expect(roomy.state.pending_intent.map((intent) => intent.intent_id)).toEqual(['call_small', hugeId]);
    expect(omittedCount(roomy.systemPreamble, 'failed tool actions')).toBe(0);
  });

  it('fills the failed group before any completed tool intent when the budget fits only part of the bounded intents', async () => {
    const drafts: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
    for (let i = 1; i <= 30; i += 1) {
      // Completed ids are padded so every completed intent is larger than any failed one: once a failed intent has not
      // fit, the room left can hold no completed intent either, whatever the order of the two groups' sizes by seq.
      const done = `call_done_${String(i).padStart(2, '0')}_${'d'.repeat(80)}`;
      drafts.push({ type: 'tool.requested', actor: 'agent', payload: { tool_call_id: done, tool: 'Bash' } });
      drafts.push({ type: 'tool.completed', payload: { tool_call_id: done, exit_code: 0 } });
      if (i > 25) continue;
      const failed = `call_fail_${String(i).padStart(2, '0')}`;
      drafts.push({ type: 'tool.requested', actor: 'agent', payload: { tool_call_id: failed, tool: 'Bash' } });
      drafts.push({ type: 'tool.failed', payload: { tool_call_id: failed, error: 'exit 1' } });
    }
    drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } });
    const events = sealEvents(drafts);
    const checkpoint = checkpointAt({ n: 1, ledgerSeq: events.length });
    const restored = restoredAt(checkpoint, events);
    expect(inGroup(restored.state.pending_intent, 'pending')).toHaveLength(25);
    expect(inGroup(restored.state.pending_intent, 'completed')).toHaveLength(30);

    const context = await createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() }).buildResumeContext(restored, {
      maxTokens: PARTIAL_BOUNDED_TOKENS,
    });

    expect(context.tokenEstimate).toBeLessThanOrEqual(PARTIAL_BOUNDED_TOKENS);
    const listed = context.state.pending_intent;
    const failedListed = inGroup(listed, 'pending').length;
    // The budget holds part of the failed group only: some listed, fewer than the cap, so the rest did not fit.
    expect(failedListed).toBeGreaterThan(0);
    expect(failedListed).toBeLessThan(PENDING_TOOL_INTENT_CAP);
    expect(listed.map((intent) => intent.intent_id)).toContain('call_fail_25');
    // DEC-034(2): failed before completed, so no completed intent is listed.
    expect(inGroup(listed, 'completed')).toEqual([]);
    expect(omittedCount(context.systemPreamble, 'failed tool actions')).toBe(25 - failedListed);
    expect(omittedCount(context.systemPreamble, 'completed tool actions')).toBe(30);
  });

  it('rejects with ERR_BUDGET only when the never-dropped intents alone do not fit', async () => {
    const drafts: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
    for (let i = 1; i <= 400; i += 1) {
      drafts.push({ type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: `se_${i}`, target: `https://hook.example.invalid/${i}` } });
    }
    drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } });
    const events = sealEvents(drafts);
    const checkpoint = checkpointAt({ n: 1, ledgerSeq: events.length });
    const restored = restoredAt(checkpoint, events);
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });

    const error = await builder.buildResumeContext(restored, { maxTokens: 2000 }).catch((err: unknown) => err);
    expect(isContextError(error, 'ERR_BUDGET')).toBe(true);

    const roomy = await builder.buildResumeContext(restored, { maxTokens: 32000 });
    expect(roomy.state.pending_intent).toEqual(restored.state.pending_intent);
    expect(roomy.tokenEstimate).toBe(Math.ceil(contextChars(roomy) / 4));
    expect(roomy.tokenEstimate).toBeLessThanOrEqual(32000);
  });
});
