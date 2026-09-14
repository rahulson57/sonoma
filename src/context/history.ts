/**
 * Tier 3 candidate retrieval (SPEC-008): one backward, paged walk over the checkpoint's own history.
 *
 * - The ledger is only ever read in [1, ledgerCursor]. No range past the cursor is requested, and an event storage
 *   returns outside the requested range is refused (ERR_CORRUPT).
 * - Abandoned windows (DEC-036(5)) come from the engine's abandonedWindows(), the one definition (DEC-025/031/032).
 *   Walking back from the cursor, every restore (`agent.resumed` / `agent.rolled_back`) that can abandon an event is
 *   recorded above it, so it is met before the walk reaches that event: the lineage marks collected so far give the
 *   exact windows for every event still ahead. An event inside a window is not a candidate in any category, and the
 *   walk jumps over the window's range without reading it.
 * - Candidates: the cited events found on the lineage, the newest tool.failed on the lineage, and the delta
 *   (parentCursor, ledgerCursor] newest first. The delta keeps only events that could fit the Tier 3 budget on their
 *   own, and stops once those add up to more than that budget, so it holds about one budget's worth of events.
 * - The walk ends once the delta is complete, every cited event is found and a failure is found. Otherwise it goes on
 *   to seq 1: when the lineage has no tool.failed, or a cited event is not on it, the whole lineage below the cursor
 *   is read, one page at a time.
 *
 * Only candidates are kept in memory, never the pages walked through.
 */
import { abandonedWindows, type AbandonedWindow, type LineageMark } from '../engine/resume-intent.js';
import type { LedgerEvent } from '../model/types.js';
import { corrupt } from './errors.js';
import type { ContextStorage } from './types.js';

/** Events per getEvents call. */
export const HISTORY_PAGE_SIZE = 1024;

const RESTORE_EVENT_TYPES: ReadonlySet<string> = new Set(['agent.resumed', 'agent.rolled_back']);

export interface HistoryQuery {
  readonly runId: string;
  /** seq of the last event the checkpoint includes. */
  readonly ledgerCursor: number;
  /** The parent checkpoint's cursor, or 0 when there is none. */
  readonly parentCursor: number;
  /** event_ids named by the provenance of the Tier 1 claims shown. */
  readonly citedEventIds: ReadonlySet<string>;
  /** Characters left for Tier 3 after Tier 1 + Tier 2. */
  readonly deltaCharLimit: number;
  /** Canonical JSON length of an event's hydrated form. */
  readonly charsOf: (event: LedgerEvent) => number;
}

export interface RelevantHistory {
  /** Cited events found on the lineage, seq ascending. */
  readonly cited: LedgerEvent[];
  /** The newest `tool.failed` on the lineage, or null. */
  readonly lastFailure: LedgerEvent | null;
  /** Events in (parentCursor, ledgerCursor] on the lineage that could fit alone, newest first, cut once past the budget. */
  readonly delta: LedgerEvent[];
  /**
   * Delta events met before the delta was cut that are larger than the whole Tier 3 budget and are neither cited nor the
   * last failure (those are counted in their own category). Candidates dropped for size, counted without being kept.
   */
  readonly oversizedDelta: number;
}

/** A restore event as the engine's fold reads it (engine.ts); abandonedWindows() ignores a target that is not before it. */
export function lineageMark(event: LedgerEvent): LineageMark | null {
  if (!RESTORE_EVENT_TYPES.has(event.type)) return null;
  const target = event.payload?.['ledger_seq'];
  return typeof target === 'number' ? { seq: event.seq, target } : null;
}

function inWindow(seq: number, windows: readonly AbandonedWindow[]): boolean {
  return windows.some(([after, upto]) => seq > after && seq <= upto);
}

export async function scanRelevantHistory(storage: ContextStorage, query: HistoryQuery): Promise<RelevantHistory> {
  const { runId, ledgerCursor, parentCursor, citedEventIds, deltaCharLimit, charsOf } = query;
  const cited = new Map<string, LedgerEvent>();
  let lastFailure: LedgerEvent | null = null;
  const delta: LedgerEvent[] = [];
  let oversizedDelta = 0;
  let deltaChars = 0;
  let deltaDone = parentCursor >= ledgerCursor;
  const marks: LineageMark[] = [];
  let windows: AbandonedWindow[] = [];
  let hi = ledgerCursor;

  const complete = (): boolean => deltaDone && lastFailure !== null && cited.size === citedEventIds.size;

  while (hi >= 1 && !complete()) {
    const lo = Math.max(1, hi - HISTORY_PAGE_SIZE + 1);
    const page = [...(await storage.getEvents(runId, { fromSeq: lo, toSeq: hi }))].sort((a, b) => b.seq - a.seq);
    for (const event of page) {
      if (event.run_id !== runId || !Number.isSafeInteger(event.seq) || event.seq < lo || event.seq > hi) {
        throw corrupt(`storage returned event seq ${String(event.seq)} of run ${String(event.run_id)} for ${runId} [${lo}, ${hi}]`);
      }
      if (inWindow(event.seq, windows)) continue;
      const mark = lineageMark(event);
      if (mark !== null) {
        marks.push(mark);
        windows = abandonedWindows(marks, ledgerCursor, ledgerCursor);
        // A well-formed restore lies inside the window it opens.
        if (inWindow(event.seq, windows)) continue;
      }
      if (citedEventIds.has(event.event_id) && !cited.has(event.event_id)) cited.set(event.event_id, event);
      if (lastFailure === null && event.type === 'tool.failed') lastFailure = event;
      if (!deltaDone) {
        if (event.seq <= parentCursor) {
          deltaDone = true;
        } else {
          const chars = charsOf(event);
          if (chars <= deltaCharLimit) {
            delta.push(event);
            deltaChars += chars + 1;
            if (deltaChars > deltaCharLimit) deltaDone = true;
          } else if (!citedEventIds.has(event.event_id) && event !== lastFailure) {
            oversizedDelta += 1;
          }
        }
      }
    }
    // abandonedWindows lists windows from the cursor down; the last one's lower bound is where the lineage continues.
    hi = Math.min(lo - 1, windows.at(-1)?.[0] ?? ledgerCursor);
    if (hi <= parentCursor) deltaDone = true;
  }

  return { cited: [...cited.values()].sort((a, b) => a.seq - b.seq), lastFailure, delta, oversizedDelta };
}
