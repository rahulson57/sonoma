/**
 * Tier 1 pending intent: the in-progress rule and the groups of the DEC-034 bound.
 *
 * In-progress rule (SPEC-008): an action is completed only on a recorded acknowledgement (status `completed` with a
 * resolved seq after the request) and failed only on a recorded failure. Anything else is rendered
 * `in_progress: outcome unknown — verify before retrying`, never as completed.
 *
 * Bound (DEC-034). The rendered list is the engine's pendingIntent, else state.pending_intent. The Agent State Object
 * keeps one PendingIntent per request ever made, so the list grows with the run, and resume must not (DEC-005).
 * - Never dropped: every intent whose outcome is unknown, and every side-effect intent whatever its status.
 *   Unacknowledged work and external effects are unsafe to lose (DEC-031).
 * - Bounded: tool intents that failed (status pending), then tool intents that completed. Within each group newest
 *   first by requested_seq, at most PENDING_TOOL_INTENT_CAP / COMPLETED_TOOL_INTENT_CAP of them, each only if it fits
 *   whole (tier1.ts). The ledger keeps every one, and a completed tool's workspace effects are in the Tier 2 commit.
 */
import type { PendingIntent } from '../model/types.js';
import { compareText, printable } from './text.js';

export const IN_PROGRESS_NOTICE = 'in_progress: outcome unknown — verify before retrying';

/** DEC-034(2): at most this many failed (status pending) tool intents are listed. */
export const PENDING_TOOL_INTENT_CAP = 20;

/** DEC-034(2): at most this many completed tool intents are listed. */
export const COMPLETED_TOOL_INTENT_CAP = 20;

export type RenderedStatus = 'completed' | 'in_progress' | 'pending';

/** `never_dropped`, or the bounded group a tool intent belongs to. */
export type IntentGroup = 'never_dropped' | 'pending' | 'completed';

export function renderedStatus(intent: PendingIntent): RenderedStatus {
  if (intent.resolved_seq !== null && intent.resolved_seq > intent.requested_seq) {
    if (intent.status === 'completed') return 'completed';
    if (intent.status === 'pending') return 'pending';
  }
  return 'in_progress';
}

export function intentGroup(intent: PendingIntent): IntentGroup {
  if (intent.kind !== 'tool') return 'never_dropped';
  const status = renderedStatus(intent);
  return status === 'in_progress' ? 'never_dropped' : status;
}

/** Rendering order: request seq, then kind, then request event id. */
export function compareIntents(a: PendingIntent, b: PendingIntent): number {
  return a.requested_seq - b.requested_seq || compareText(a.kind, b.kind) || compareText(a.request_event_id, b.request_event_id);
}

export function intentLine(intent: PendingIntent, ledgerCursor: number): string {
  const who = `${intent.kind} ${intent.intent_id === null ? '(no id)' : printable(intent.intent_id)}`;
  const requested = `requested at seq ${intent.requested_seq} (event ${printable(intent.request_event_id)})`;
  const after = intent.requested_seq > ledgerCursor ? ' [recorded after this checkpoint]' : '';
  switch (renderedStatus(intent)) {
    case 'completed':
      return `  - ${who}, ${requested}: acknowledged at seq ${String(intent.resolved_seq)}${after}`;
    case 'pending':
      return `  - ${who}, ${requested}: failed at seq ${String(intent.resolved_seq)}; not done${after}`;
    case 'in_progress':
      return `  - ${who}, ${requested}: ${IN_PROGRESS_NOTICE}${after}`;
  }
}
