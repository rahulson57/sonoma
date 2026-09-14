/**
 * DEC-025 / DEC-031: pending intent over abandoned ledger windows. Tool intents are reported as of the history the
 * restored workspace descends from, plus unresolved later requests; side-effect intents always carry their status as
 * of the ledger head. Pure derivation over ledger events; no storage, git or clock.
 */
import { describe, expect, it } from 'vitest';
import { derivePendingIntent } from '../../../src/ledger/pending-intent.js';
import type { LedgerEvent, PendingIntent } from '../../../src/model/types.js';
import { abandonedWindows, pendingIntentAt } from '../../../src/engine/resume-intent.js';

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

/** resume(ref) on a run with no earlier restore: the single window (cursor, head]. */
function atCursor(events: readonly LedgerEvent[], cursor: number): PendingIntent[] {
  const head = Math.max(0, ...events.map((event) => event.seq));
  return pendingIntentAt(events, abandonedWindows([], cursor, head));
}

describe('pendingIntentAt, tool intents (DEC-025)', () => {
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
    const report = atCursor(events, cursor);
    const upToCursor = report.filter((intent) => intent.requested_seq <= cursor);
    expect(pairs(upToCursor)).toEqual([
      ['tool', 'done', 'completed'],
      ['tool', 'acked_later', 'in_progress'],
      ['tool', 'failed_before', 'pending'],
      ['tool', 'failed_later', 'in_progress'],
    ]);
    expect(upToCursor).toEqual(derivePendingIntent(events.filter((event) => event.seq <= cursor)));
    expect(upToCursor.find((intent) => intent.intent_id === 'acked_later')?.resolved_seq).toBeNull();
  });

  it('rule 2 and 3: after the cursor, only requests never resolved through head are reported, as in_progress', () => {
    const after = atCursor(events, cursor).filter((intent) => intent.requested_seq > cursor);
    expect(pairs(after)).toEqual([['tool', 'late', 'in_progress']]);
    expect(after[0]).toMatchObject({ resolved_seq: null });
  });

  it('never reports a request completed on an acknowledgement recorded after the cursor', () => {
    const completed = atCursor(events, cursor).filter((intent) => intent.status === 'completed');
    expect(completed.map((intent) => intent.intent_id)).toEqual(['done']);
    expect(completed.every((intent) => (intent.resolved_seq ?? Infinity) <= cursor)).toBe(true);
  });

  it('returns entries in request seq order, whatever the input order', () => {
    const report = atCursor(events, cursor);
    const seqs = report.map((intent) => intent.requested_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(atCursor([...events].reverse(), cursor)).toEqual(report);
  });

  it('with the cursor at the ledger head (the latest checkpoint, nothing after it) equals derivePendingIntent', () => {
    expect(atCursor(events, events.length)).toEqual(derivePendingIntent(events));
    expect(pendingIntentAt(events, [])).toEqual(derivePendingIntent(events));
  });

  it('with the cursor before any event reports only requests never resolved', () => {
    expect(pairs(atCursor(events, 0))).toEqual([['tool', 'late', 'in_progress']]);
  });

  it('an id reused after the cursor: the later acknowledgement resolves only the later request, which is then not reported', () => {
    const reused = ledger([['tool.requested', 'x'], ['cursor'], ['tool.requested', 'x'], ['tool.completed', 'x']]);
    const report = atCursor(reused.events, reused.cursors[0] as number);
    expect(pairs(report)).toEqual([['tool', 'x', 'in_progress']]);
    expect(report[0]?.requested_seq).toBe(1);
  });

  it('a request after the cursor with no id stays in_progress: an acknowledgement cannot be matched to it', () => {
    const anonymous = ledger([['cursor'], ['tool.requested', null], ['tool.completed', null]]);
    expect(pairs(atCursor(anonymous.events, anonymous.cursors[0] as number))).toEqual([['tool', null, 'in_progress']]);
  });
});

describe('pendingIntentAt, side-effect intents (DEC-031)', () => {
  it('side_effect intents are never filtered: each carries its status as of the ledger head, wherever it lies', () => {
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
    const cursor = effects.cursors[0] as number;
    const report = atCursor(effects.events, cursor);
    expect(pairs(report)).toEqual([
      ['side_effect', 'se_done', 'completed'],
      ['side_effect', 'se_committed_later', 'completed'],
      ['side_effect', 'se_after_committed', 'completed'],
      ['side_effect', 'se_after_open', 'in_progress'],
    ]);
    expect(report).toEqual(derivePendingIntent(effects.events));
    // requested_seq is how a consumer tells the effects recorded after the checkpoint apart.
    expect(report.filter((intent) => intent.requested_seq > cursor).map((intent) => intent.intent_id)).toEqual(['se_after_committed', 'se_after_open']);
  });

  it('in one window, the acknowledged tool request is dropped and the committed side effect is reported completed', () => {
    const mixed = ledger([
      ['tool.requested', 'call_read'],
      ['tool.completed', 'call_read'],
      ['cursor'],
      ['tool.requested', 'call_edit'],
      ['tool.completed', 'call_edit'],
      ['side_effect.requested', 'se_email'],
      ['side_effect.committed', 'se_email'],
    ]);
    expect(pairs(atCursor(mixed.events, mixed.cursors[0] as number))).toEqual([
      ['tool', 'call_read', 'completed'],
      ['side_effect', 'se_email', 'completed'],
    ]);
  });
});

describe('abandonedWindows (DEC-031)', () => {
  it('resume(ref) on a run with no earlier restore abandons (cursor, head]; at the head nothing is abandoned', () => {
    expect(abandonedWindows([], 5, 9)).toEqual([[5, 9]]);
    expect(abandonedWindows([], 9, 9)).toEqual([]);
  });

  it('checkpoint() after a restore to cursor T at seq L abandons (T, L]', () => {
    expect(abandonedWindows([{ seq: 12, target: 4 }], 15, 15)).toEqual([[4, 12]]);
  });

  it('resume of a checkpoint taken after an earlier restore keeps that restore window as well as (cursor, head]', () => {
    // c_1 at 4, restore to c_1 at 12, c_3 at 16, then resume(c_3) with the head at 20.
    expect(abandonedWindows([{ seq: 12, target: 4 }], 16, 20)).toEqual([
      [16, 20],
      [4, 12],
    ]);
    // A restore after the cursor lies in (cursor, head] and adds nothing.
    expect(abandonedWindows([{ seq: 18, target: 16 }, { seq: 12, target: 4 }], 16, 20)).toEqual([
      [16, 20],
      [4, 12],
    ]);
  });

  it('a restore to a checkpoint taken before an earlier restore follows that checkpoint history, in any input order', () => {
    // c_1 at 4, c_2 at 8, rollback(c_1) at 10, resume(c_2) at 14: c_2's workspace holds (4, 8], so only (8, 14] is abandoned.
    expect(abandonedWindows([{ seq: 10, target: 4 }, { seq: 14, target: 8 }], 16, 16)).toEqual([[8, 14]]);
    // rollback to 4 at 10, then a restore to 2 at 14: the restore at 10 lies inside (2, 14] and does not count.
    expect(abandonedWindows([{ seq: 10, target: 4 }, { seq: 14, target: 2 }], 16, 16)).toEqual([[2, 14]]);
  });

  it('checkpoint() after resume(c_1): an edit acknowledged in the window is not reported, work acknowledged after the restore is', () => {
    const run = ledger([
      ['tool.requested', 'call_read'],
      ['tool.completed', 'call_read'],
      ['cursor'], // c_1 at 3
      ['tool.requested', 'call_edit'],
      ['tool.completed', 'call_edit'],
      ['side_effect.requested', 'se_email'],
      ['side_effect.committed', 'se_email'],
      ['tool.requested', 'call_late'],
      ['cursor'], // c_2 at 9
      ['agent.resumed', null], // resume(c_1) at 10
      ['tool.requested', 'call_next'],
      ['tool.completed', 'call_next'],
    ]);
    const c1 = run.cursors[0] as number;
    const head = run.events.length;
    const windows = abandonedWindows([{ seq: 10, target: c1 }], head, head);
    expect(windows).toEqual([[c1, 10]]);
    expect(pairs(pendingIntentAt(run.events, windows))).toEqual([
      ['tool', 'call_read', 'completed'],
      ['side_effect', 'se_email', 'completed'],
      ['tool', 'call_late', 'in_progress'],
      ['tool', 'call_next', 'completed'],
    ]);
  });
});
