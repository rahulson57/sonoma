import { describe, expect, it } from 'vitest';
import { fakeLedgerEvents } from '../../helpers/ledger.js';
import { sha256Hex } from '../../../src/ledger/hash.js';
import { ExecutionLedger, MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { derivePendingIntent } from '../../../src/ledger/pending-intent.js';
import type { LedgerActor, LedgerEvent, LedgerEventType } from '../../../src/model/types.js';

const RUN = 'run_01J8Z3K5QW7XV2M9N4P6R8T0AB';

interface Step {
  readonly type: LedgerEventType;
  readonly payload: Record<string, unknown>;
  readonly actor?: LedgerActor;
}

async function sealed(steps: readonly Step[], runId = RUN): Promise<LedgerEvent[]> {
  let n = 0;
  const ledger = new ExecutionLedger({
    run_id: runId,
    blobs: {
      async putBlob(data) {
        return { sha256: sha256Hex(data), size: data.byteLength };
      },
    },
    clock: { now: () => 0 },
    newEventId: () => `evt_${(n += 1)}`,
  });
  const out: LedgerEvent[] = [];
  for (const step of steps) {
    const actor = step.actor ?? (step.type.endsWith('.requested') ? 'agent' : 'runtime');
    out.push(await ledger.append({ run_id: runId, type: step.type, actor, payload: step.payload }));
  }
  return out;
}

describe('derivePendingIntent (SPEC-004 resume rule)', () => {
  it('marks a tool.requested with no tool.completed as in_progress, never completed', async () => {
    const events = await sealed([
      { type: 'run.created', payload: {} },
      { type: 'tool.requested', payload: { tool_call_id: 't1', tool: 'Bash' } },
      { type: 'tool.completed', payload: { tool_call_id: 't2' } }, // someone else's acknowledgement
      { type: 'side_effect.committed', payload: { side_effect_id: 't1' } }, // wrong kind, same id
      { type: 'workspace.changed', payload: { paths: ['a.ts'], tool_call_id: 't1' } }, // not an acknowledgement
    ]);
    expect(derivePendingIntent(events)).toEqual([
      { kind: 'tool', intent_id: 't1', request_event_id: 'evt_2', status: 'in_progress', requested_seq: 2, resolved_seq: null },
    ]);
  });

  it('marks it completed only once the ledger holds tool.completed', async () => {
    const events = await sealed([
      { type: 'tool.requested', payload: { tool_call_id: 't1' } },
      { type: 'tool.completed', payload: { tool_call_id: 't1', exit_code: 0 } },
    ]);
    expect(derivePendingIntent(events)).toMatchObject([{ intent_id: 't1', status: 'completed', resolved_seq: 2 }]);
    expect(derivePendingIntent(events.slice(0, 1))).toMatchObject([{ intent_id: 't1', status: 'in_progress' }]);
  });

  it('marks a failed tool call pending, never completed, and a later acknowledgement still completes it', async () => {
    const events = await sealed([
      { type: 'tool.requested', payload: { tool_call_id: 't1' } },
      { type: 'tool.failed', payload: { tool_call_id: 't1', error: 'boom' } },
      { type: 'tool.completed', payload: { tool_call_id: 't1' } },
      { type: 'tool.failed', payload: { tool_call_id: 't1', error: 'late noise' } },
    ]);
    expect(derivePendingIntent(events.slice(0, 2))).toMatchObject([{ status: 'pending', resolved_seq: 2 }]);
    expect(derivePendingIntent(events)).toMatchObject([{ status: 'completed', resolved_seq: 3 }]);
  });

  it('ignores an acknowledgement recorded before its request', async () => {
    const events = await sealed([
      { type: 'tool.completed', payload: { tool_call_id: 't1' } },
      { type: 'tool.requested', payload: { tool_call_id: 't1' } },
    ]);
    expect(derivePendingIntent(events)).toMatchObject([{ intent_id: 't1', status: 'in_progress', requested_seq: 2 }]);
  });

  it('applies the same rule to side effects: completed only with side_effect.committed', async () => {
    const events = await sealed([
      { type: 'side_effect.requested', payload: { side_effect_id: 's1', target: 'deploy' } },
      { type: 'side_effect.requested', payload: { side_effect_id: 's2', target: 'email' } },
      { type: 'side_effect.committed', payload: { side_effect_id: 's2' } },
    ]);
    expect(derivePendingIntent(events)).toMatchObject([
      { kind: 'side_effect', intent_id: 's1', status: 'in_progress' },
      { kind: 'side_effect', intent_id: 's2', status: 'completed', resolved_seq: 3 },
    ]);
  });

  it('an acknowledgement whose payload was offloaded to a blob cannot complete the intent', async () => {
    const events = await sealed([
      { type: 'tool.requested', payload: { tool_call_id: 't1' } },
      { type: 'tool.completed', payload: { tool_call_id: 't1', stdout: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES) } },
    ]);
    expect(events[1]!.payload).toBeNull();
    expect(derivePendingIntent(events)).toMatchObject([{ intent_id: 't1', status: 'in_progress', resolved_seq: null }]);
  });

  it('reports a request without an id as in_progress with a null intent_id', async () => {
    const events = await sealed([
      { type: 'tool.requested', payload: { tool: 'Bash' } },
      { type: 'tool.completed', payload: {} },
    ]);
    expect(derivePendingIntent(events)).toEqual([
      { kind: 'tool', intent_id: null, request_event_id: 'evt_1', status: 'in_progress', requested_seq: 1, resolved_seq: null },
    ]);
  });

  it('does not depend on input order and returns frozen intents', async () => {
    const events = await sealed([
      { type: 'tool.requested', payload: { tool_call_id: 't1' } },
      { type: 'tool.requested', payload: { tool_call_id: 't2' } },
      { type: 'tool.completed', payload: { tool_call_id: 't1' } },
    ]);
    const intents = derivePendingIntent([...events].reverse());
    expect(intents).toEqual(derivePendingIntent(events));
    expect(Object.isFrozen(intents[0])).toBe(true);
  });

  it('over a fakeLedgerEvents() stream, only acknowledged tool calls are completed', async () => {
    const fakes = fakeLedgerEvents(3_000, 11);
    const events = await sealed(fakes.map((e) => ({ type: e.type, actor: e.actor, payload: e.payload })), fakes[0]!.run_id);
    const intents = derivePendingIntent(events).filter((i) => i.kind === 'tool');
    expect(intents).toHaveLength(events.filter((e) => e.type === 'tool.requested').length);

    const idOf = (e: LedgerEvent): unknown => e.payload?.['tool_call_id'];
    for (const intent of intents) {
      const later = events.filter((e) => e.seq > intent.requested_seq && idOf(e) === intent.intent_id);
      const expected = later.some((e) => e.type === 'tool.completed')
        ? 'completed'
        : later.some((e) => e.type === 'tool.failed')
          ? 'pending'
          : 'in_progress';
      expect(intent.status).toBe(expected);
    }
    expect(intents.some((i) => i.status === 'pending')).toBe(true);
  });

  it('a stream cut right after a tool.requested leaves that intent in_progress', async () => {
    let fakes = fakeLedgerEvents(3, 5);
    for (let n = 4; n < 1_000 && fakes[fakes.length - 1]!.type !== 'tool.requested'; n += 1) fakes = fakeLedgerEvents(n, 5);
    const last = fakes[fakes.length - 1]!;
    expect(last.type).toBe('tool.requested');

    const events = await sealed(fakes.map((e) => ({ type: e.type, actor: e.actor, payload: e.payload })), fakes[0]!.run_id);
    const intents = derivePendingIntent(events);
    expect(intents[intents.length - 1]).toMatchObject({
      intent_id: last.payload['tool_call_id'],
      status: 'in_progress',
      requested_seq: events[events.length - 1]!.seq,
      resolved_seq: null,
    });
  });
});
