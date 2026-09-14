/**
 * SPEC-008 in-progress rule: a `tool.requested` with no matching `tool.completed` / `tool.failed` is rendered as
 * `in_progress: outcome unknown — verify before retrying`, never as completed. Intent alone never reads as done.
 */
import { describe, expect, it } from 'vitest';
import { IN_PROGRESS_NOTICE, createContextBuilder, renderedStatus } from '../../../src/context/index.js';
import type { PendingIntent } from '../../../src/model/types.js';
import { MemoryStorage, checkpointAt, fakeGit, restoredAt, sealEvents, sectionLines, type Draft } from './support.js';

const drafts: Draft[] = [
  { type: 'run.created', payload: { agent: 'claude-code' } },
  { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_edit', tool: 'Edit', input: { path: 'src/app.ts' } } },
  { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_read', tool: 'Read', input: { path: 'README.md' } } },
  { type: 'tool.completed', payload: { tool_call_id: 'call_read', exit_code: 0 } },
  { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_test', tool: 'Bash', input: { command: 'npm test' } } },
  { type: 'tool.failed', payload: { tool_call_id: 'call_test', error: 'exit 1' } },
  { type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: 'se_email', target: 'mailto:ops@example.invalid' } },
  { type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } },
];
const events = sealEvents(drafts);
const checkpoint = checkpointAt({ n: 1, ledgerSeq: events.length });

function lineFor(lines: readonly string[], id: string): string | undefined {
  return lines.find((line) => line.includes(` ${id},`));
}

describe('in-progress rule', () => {
  it('renders a tool.requested with no completion as in_progress with outcome unknown, never completed', async () => {
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });
    const context = await builder.buildResumeContext(restoredAt(checkpoint, events), { maxTokens: 8000 });

    const completed = sectionLines(context.systemPreamble, 'completed');
    const inProgress = sectionLines(context.systemPreamble, 'in_progress');
    const pending = sectionLines(context.systemPreamble, 'pending');

    expect(lineFor(inProgress, 'call_edit')).toContain(IN_PROGRESS_NOTICE);
    expect(IN_PROGRESS_NOTICE).toBe('in_progress: outcome unknown — verify before retrying');
    expect(lineFor(completed, 'call_edit')).toBeUndefined();
    expect(lineFor(pending, 'call_edit')).toBeUndefined();

    expect(lineFor(completed, 'call_read')).toContain('acknowledged at seq 4');
    expect(lineFor(pending, 'call_test')).toContain('failed at seq 6; not done');
    expect(lineFor(completed, 'call_test')).toBeUndefined();
    // Side effects follow the same rule: requested, never committed.
    expect(lineFor(inProgress, 'se_email')).toContain(IN_PROGRESS_NOTICE);
    expect(lineFor(completed, 'se_email')).toBeUndefined();

    // Nothing in Tier 3 acknowledges the unfinished edit either.
    const acknowledged = context.hydratedEvents.filter((event) => event.type === 'tool.completed' && event.payload?.['tool_call_id'] === 'call_edit');
    expect(acknowledged).toEqual([]);
  });

  it('renders the engine’s pendingIntent, including a request recorded after the cursor, as in_progress and never hydrates it', async () => {
    const extended = sealEvents([
      ...drafts,
      { type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_late', tool: 'Write', input: { path: 'src/late.ts' } } },
    ]);
    const restored = restoredAt(checkpoint, extended);
    const late = extended.at(-1);
    if (late === undefined) throw new Error('fixture missing late request');
    const pendingIntent: PendingIntent[] = [
      ...restored.state.pending_intent,
      { kind: 'tool', intent_id: 'call_late', request_event_id: late.event_id, status: 'in_progress', requested_seq: late.seq, resolved_seq: null },
    ];
    const builder = createContextBuilder({ storage: new MemoryStorage(extended, [checkpoint]), git: fakeGit() });

    const context = await builder.buildResumeContext({ ...restored, pendingIntent }, { maxTokens: 32000 });

    const line = lineFor(sectionLines(context.systemPreamble, 'in_progress'), 'call_late');
    expect(line).toContain(IN_PROGRESS_NOTICE);
    expect(line).toContain('[recorded after this checkpoint]');
    expect(context.hydratedEvents.some((event) => event.event_id === late.event_id)).toBe(false);
  });

  it('never reports completed without a recorded acknowledgement after the request', () => {
    const base: PendingIntent = { kind: 'tool', intent_id: 'call_x', request_event_id: 'evt_x', status: 'completed', requested_seq: 10, resolved_seq: 11 };
    expect(renderedStatus(base)).toBe('completed');
    expect(renderedStatus({ ...base, resolved_seq: null })).toBe('in_progress');
    expect(renderedStatus({ ...base, resolved_seq: 10 })).toBe('in_progress');
    expect(renderedStatus({ ...base, resolved_seq: 9 })).toBe('in_progress');
    expect(renderedStatus({ ...base, status: 'in_progress', resolved_seq: null })).toBe('in_progress');
    expect(renderedStatus({ ...base, status: 'pending' })).toBe('pending');
    expect(renderedStatus({ ...base, status: 'pending', resolved_seq: null })).toBe('in_progress');
  });
});
