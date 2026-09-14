/**
 * Pending intent as the engine reports it: `resume(ref)` (DEC-025) and the state `checkpoint()` records (DEC-031).
 * One filter serves both.
 *
 * resume and rollback restore the workspace to an older checkpoint. That ABANDONS the ledger events recorded after
 * the checkpoint's cursor: their managed effects are not in the restored workspace. An abandoned window is a seq
 * range (after, upto] of such events; abandonedWindows() lists the windows that apply at a position.
 *
 * TOOL intents (tool.requested / tool.completed / tool.failed), DEC-025:
 * 1. A request outside every window is correlated only with acknowledgements and failures outside every window. One
 *    recorded inside a window does not count, so the request stays in_progress (or keeps the outcome it already had).
 *    With a single window (cursor, head] this is exactly derivePendingIntent over the events up to the cursor.
 * 2. A request inside a window with no acknowledgement and no failure anywhere through the ledger head is reported
 *    in_progress: its outcome is unknown and it may have had external effects.
 * 3. A request inside a window that was acknowledged or failed is not reported at all.
 *
 * SIDE-EFFECT intents (side_effect.requested / side_effect.committed), DEC-031: NEVER filtered. They are external and
 * "recorded, never undone" (SPEC-004), and restoring a workspace does not undo them, so each is reported with its
 * status as of the ledger head wherever it lies. `requested_seq` tells a consumer which ones come after a checkpoint.
 */
import { derivePendingIntent } from '../ledger/pending-intent.js';
import type { LedgerEvent, PendingIntent } from '../model/types.js';

/** A restore recorded in the run's ledger: `agent.resumed` or `agent.rolled_back`. */
export interface LineageMark {
  /** seq of the lineage event. */
  readonly seq: number;
  /** ledger_seq of the checkpoint it restored. */
  readonly target: number;
}

/** (after, upto]: events with after < seq <= upto are abandoned. */
export type AbandonedWindow = readonly [after: number, upto: number];

const TOOL_RESOLUTIONS: ReadonlySet<string> = new Set(['tool.completed', 'tool.failed']);

/**
 * The windows abandoned by the history that leads to `cursor`, plus (cursor, head] when cursor < head.
 *
 * Walks back from `cursor`: the latest restore at or before the position, at seq L to a checkpoint with cursor T,
 * abandons (T, L], and the history before it is the history that leads to T. A restore lying inside an abandoned
 * window was itself abandoned and does not count.
 * - resume(ref): abandonedWindows(lineage, ref.ledger_seq, head)
 * - checkpoint(): abandonedWindows(lineage, head, head)
 */
export function abandonedWindows(lineage: readonly LineageMark[], cursor: number, head: number): AbandonedWindow[] {
  const windows: AbandonedWindow[] = cursor < head ? [[cursor, head]] : [];
  let position = cursor;
  for (const mark of [...lineage].sort((a, b) => b.seq - a.seq)) {
    if (mark.seq > position || mark.target >= mark.seq) continue;
    windows.push([mark.target, mark.seq]);
    position = mark.target;
  }
  return windows;
}

/** One entry per reported request, in seq order. `events` may be in any order. */
export function pendingIntentAt(events: readonly LedgerEvent[], windows: readonly AbandonedWindow[]): PendingIntent[] {
  const abandoned = (seq: number): boolean => windows.some(([after, upto]) => seq > after && seq <= upto);
  // The ledger's own correlation through head: rules 2 and 3, and every side effect.
  const throughHead = derivePendingIntent(events);
  // Rule 1: tool acknowledgements and failures inside a window never resolve anything.
  const outsideWindows = new Map(
    derivePendingIntent(events.filter((event) => !(TOOL_RESOLUTIONS.has(event.type) && abandoned(event.seq)))).map((intent) => [
      intent.requested_seq,
      intent,
    ]),
  );

  const reported: PendingIntent[] = [];
  for (const intent of throughHead) {
    if (intent.kind !== 'tool') {
      reported.push(intent);
    } else if (abandoned(intent.requested_seq)) {
      if (intent.status === 'in_progress') reported.push(intent);
    } else {
      const asRestored = outsideWindows.get(intent.requested_seq);
      if (asRestored !== undefined) reported.push(asRestored);
    }
  }
  return reported;
}
