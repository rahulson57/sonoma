/**
 * Tier 3 candidate retrieval (SPEC-008): one backward, paged walk over the checkpoint's own history.
 *
 * Bounds:
 * - The ledger is only ever read in [1, ledgerCursor]; no range past the cursor is requested, and an event
 *   storage returns outside the requested range is refused (ERR_CORRUPT).
 * - The walk follows the checkpoint's LINEAGE, exactly as the engine's abandonedWindows() does (DEC-025/031/032):
 *   walking back from the cursor, a restore (`agent.resumed` / `agent.rolled_back`) at seq L to a checkpoint with
 *   cursor T abandons (T, L]. Those events' managed effects are not in the restored workspace, so none of them is a
 *   candidate, and a restore inside an abandoned window is itself ignored.
 * - It stops as soon as every cited event and the last failure are found and the delta is complete, where the delta
 *   is complete at the parent cursor or once its candidates alone exceed the character budget (selection stops at the
 *   first event that does not fit, so later ones could never be chosen).
 *
 * Only candidates are kept in memory, never the pages walked through.
 */
import type { LedgerEvent } from '../model/types.js';
import { ContextError } from './errors.js';
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
  /** event_ids named by Tier 1 claim provenance. */
  readonly citedEventIds: ReadonlySet<string>;
  /** Characters left for Tier 3 after Tier 1 + Tier 2. */
  readonly deltaCharLimit: number;
  /** JSON length of an event's hydrated form. */
  readonly charsOf: (event: LedgerEvent) => number;
}

export interface RelevantHistory {
  /** Cited events found on the lineage, seq ascending. */
  readonly cited: LedgerEvent[];
  /** The newest `tool.failed` on the lineage, or null. */
  readonly lastFailure: LedgerEvent | null;
  /** Events in (parentCursor, ledgerCursor] on the lineage, newest first, cut once past the character budget. */
  readonly delta: LedgerEvent[];
}

/** The cursor a restore event returned to, or null when the event is not a well-formed restore. */
export function restoreTarget(event: LedgerEvent): number | null {
  if (!RESTORE_EVENT_TYPES.has(event.type)) return null;
  const target = event.payload?.['ledger_seq'];
  return typeof target === 'number' && Number.isSafeInteger(target) && target >= 0 && target < event.seq ? target : null;
}

export async function scanRelevantHistory(storage: ContextStorage, query: HistoryQuery): Promise<RelevantHistory> {
  const { runId, ledgerCursor, parentCursor, citedEventIds, deltaCharLimit, charsOf } = query;
  const cited = new Map<string, LedgerEvent>();
  let lastFailure: LedgerEvent | null = null;
  const delta: LedgerEvent[] = [];
  let deltaChars = 0;
  let deltaDone = parentCursor >= ledgerCursor;
  // Events with seq <= position lie on the lineage that leads to the cursor.
  let position = ledgerCursor;
  let hi = ledgerCursor;

  const complete = (): boolean => deltaDone && lastFailure !== null && cited.size === citedEventIds.size;

  while (hi >= 1 && !complete()) {
    const lo = Math.max(1, hi - HISTORY_PAGE_SIZE + 1);
    const page = [...(await storage.getEvents(runId, { fromSeq: lo, toSeq: hi }))].sort((a, b) => b.seq - a.seq);
    for (const event of page) {
      if (event.run_id !== runId || !Number.isSafeInteger(event.seq) || event.seq < lo || event.seq > hi) {
        throw new ContextError('ERR_CORRUPT', `storage returned event seq ${String(event.seq)} of run ${String(event.run_id)} for ${runId} [${lo}, ${hi}]`);
      }
      if (event.seq > position) continue;
      const target = restoreTarget(event);
      if (target !== null) {
        position = target;
        continue;
      }
      if (citedEventIds.has(event.event_id) && !cited.has(event.event_id)) cited.set(event.event_id, event);
      if (lastFailure === null && event.type === 'tool.failed') lastFailure = event;
      if (!deltaDone) {
        if (event.seq <= parentCursor) {
          deltaDone = true;
        } else {
          delta.push(event);
          deltaChars += charsOf(event) + 1;
          if (deltaChars > deltaCharLimit) deltaDone = true;
        }
      }
    }
    hi = Math.min(lo - 1, position);
  }

  return { cited: [...cited.values()].sort((a, b) => a.seq - b.seq), lastFailure, delta };
}
