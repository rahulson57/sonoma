/**
 * Pending intent as resume(ref) reports it (DEC-025).
 *
 * resume restores the workspace to the checkpoint's workspace_commit, so pending intent is derived AS OF the
 * checkpoint's ledger cursor (`ledger_seq`), then widened by later requests that were never resolved:
 * 1. A request at or before the cursor is reported exactly as the ledger stood at the cursor
 *    (derivePendingIntent over events with seq ≤ cursor). An acknowledgement recorded after the cursor does
 *    not count, so that request stays in_progress, and a failure recorded after it leaves it in_progress too.
 * 2. A request after the cursor with no acknowledgement and no failure anywhere through the ledger head is
 *    reported in_progress: its outcome is unknown and it may have had external effects.
 * 3. A request after the cursor that was acknowledged or failed is not reported at all. Its managed effects
 *    are not in the restored workspace.
 * The same rule holds for the latest checkpoint and for older ones. With the cursor at the ledger head the
 * result is exactly derivePendingIntent(events). Tool and side_effect intents follow the same rule, because
 * derivePendingIntent correlates both kinds alike.
 */
import { derivePendingIntent } from '../ledger/pending-intent.js';
import type { LedgerEvent, PendingIntent } from '../model/types.js';

/** One entry per reported request, in seq order. `events` may be in any order and may extend past the cursor. */
export function pendingIntentAt(events: readonly LedgerEvent[], cursor: number): PendingIntent[] {
  const atCursor = derivePendingIntent(events.filter((event) => event.seq <= cursor));
  const unresolvedAfter = derivePendingIntent(events).filter(
    (intent) => intent.requested_seq > cursor && intent.status === 'in_progress',
  );
  return [...atCursor, ...unresolvedAfter];
}
