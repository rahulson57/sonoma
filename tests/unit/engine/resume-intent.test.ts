/**
 * DEC-025: resume(ref) reports pending intent AS OF ref's ledger cursor, plus post-cursor requests that were
 * never resolved through the ledger head. Pure derivation over ledger events; no storage, git or clock.
 */
import { describe, expect, it } from 'vitest';
import { derivePendingIntent } from '../../../src/ledger/pending-intent.js';
import type { LedgerEvent, PendingIntent } from '../../../src/model/types.js';
import { pendingIntentAt } from '../../../src/engine/resume-intent.js';

type Step = readonly [type: string, id: string | null] | readonly ['cursor'];

/** Seals `steps` into events with contiguous seqs; returns the events and the seq of each 'cursor' marker. */
function ledger(steps: readonly Step[]): { events: LedgerEvent[]; cursors: number[] } {
  const events: LedgerEvent[] = [];
  const cursors: number[] = [];
  for (const step of steps) {
    const seq = events.length + 1;
    const [type, id] = step;
    if (type === 'cursor') cursors.push(seq);
    const key = type.startsWith('side_effect.') ? 'side_effect_id' : 'tool_call_id';
    const payload = type === 'cursor' ? { checkpoint_id: `c_${cursors.length}` } : id === null ? {} : { [key]: id };
    events.push({
      event_id: `evt_${seq}`,
      run_id: 'run_1',
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      type: type === 'cursor' ? 'checkpoint.created' : type,
      actor: 'runtime',
      payload,
      payload_ref: null,
      prev_hash: '0'.repeat(64),
      hash: '0'.repeat(64),
    } as unknown as LedgerEvent);
  }
  return { events, cursors };
}

const pairs = (intents: readonly PendingIntent[]): Array<[string, string | null, string]> =>
  intents.map((intent) => [intent.kind, intent.intent_id, intent.status]);

describe('pendingIntentAt (DEC-025)', () => {
  const { events, cursors } = ledger([
    ['tool.requested', 'done'],
    ['tool.completed', 'done'],
    ['tool.requested', 'acked_later'],
    ['tool.requested', 'failed_before'],
    ['tool.failed', 'failed_before'],
    ['tool.requested', 'failed_later'],
    ['cursor'],
    ['tool.requested', 'edit'],
    ['tool.completed', 'edit'],
    ['tool.completed', 'acked_later'],
    ['tool.failed', 'failed_later'],
    ['tool.requested', 'late'],
    ['tool.requested', 'late_failed'],
    ['tool.failed', 'late_failed'],
  ]);
  const cursor = cursors[0] as number;

  it('rule 1: requests at or before the cursor are reported as the ledger stood at the cursor', () => {
    const report = pendingIntentAt(events, cursor);
    const atCursor = report.filter((intent) => intent.requested_seq <= cursor);
    expect(pairs(atCursor)).toEqual([
      ['tool', 'done', 'completed'],
      ['tool', 'acked_later', 'in_progress'],
      ['tool', 'failed_before', 'pending'],
      ['tool', 'failed_later', 'in_progress'],
    ]);
    expect(atCursor).toEqual(derivePendingIntent(events.filter((event) => event.seq <= cursor)));
    expect(atCursor.find((intent) => intent.intent_id === 'acked_later')?.resolved_seq).toBeNull();
  });

  it('rule 2 and 3: after the cursor, only requests never resolved through head are reported, as in_progress', () => {
    const after = pendingIntentAt(events, cursor).filter((intent) => intent.requested_seq > cursor);
    expect(pairs(after)).toEqual([['tool', 'late', 'in_progress']]);
    expect(after[0]).toMatchObject({ resolved_seq: null });
  });

  it('never reports a request completed on an acknowledgement recorded after the cursor', () => {
    const completed = pendingIntentAt(events, cursor).filter((intent) => intent.status === 'completed');
    expect(completed.map((intent) => intent.intent_id)).toEqual(['done']);
    expect(completed.every((intent) => (intent.resolved_seq ?? Infinity) <= cursor)).toBe(true);
  });

  it('returns entries in request seq order, whatever the input order', () => {
    const report = pendingIntentAt(events, cursor);
    const seqs = report.map((intent) => intent.requested_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(pendingIntentAt([...events].reverse(), cursor)).toEqual(report);
  });

  it('with the cursor at the ledger head (the latest checkpoint, nothing after it) equals derivePendingIntent', () => {
    const head = events.length;
    expect(pendingIntentAt(events, head)).toEqual(derivePendingIntent(events));
  });

  it('with the cursor before any event reports only requests never resolved', () => {
    expect(pairs(pendingIntentAt(events, 0))).toEqual([['tool', 'late', 'in_progress']]);
  });

  it('an id reused after the cursor: the later acknowledgement resolves only the later request, which is then not reported', () => {
    const reused = ledger([['tool.requested', 'x'], ['cursor'], ['tool.requested', 'x'], ['tool.completed', 'x']]);
    const report = pendingIntentAt(reused.events, reused.cursors[0] as number);
    expect(pairs(report)).toEqual([['tool', 'x', 'in_progress']]);
    expect(report[0]?.requested_seq).toBe(1);
  });

  it('a request after the cursor with no id stays in_progress: an acknowledgement cannot be matched to it', () => {
    const anonymous = ledger([['cursor'], ['tool.requested', null], ['tool.completed', null]]);
    expect(pairs(pendingIntentAt(anonymous.events, anonymous.cursors[0] as number))).toEqual([['tool', null, 'in_progress']]);
  });

  it('side_effect intents follow the same cursor rule as tool intents', () => {
    const effects = ledger([
      ['side_effect.requested', 'se_done'],
      ['side_effect.committed', 'se_done'],
      ['side_effect.requested', 'se_committed_later'],
      ['cursor'],
      ['side_effect.committed', 'se_committed_later'],
      ['side_effect.requested', 'se_after_committed'],
      ['side_effect.committed', 'se_after_committed'],
      ['side_effect.requested', 'se_after_open'],
    ]);
    expect(pairs(pendingIntentAt(effects.events, effects.cursors[0] as number))).toEqual([
      ['side_effect', 'se_done', 'completed'],
      ['side_effect', 'se_committed_later', 'in_progress'],
      ['side_effect', 'se_after_open', 'in_progress'],
    ]);
  });
});
