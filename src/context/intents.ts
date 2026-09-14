/**
 * Tier 1 pending intent: the in-progress rule and the bound that keeps Tier 1 from growing with run length.
 *
 * In-progress rule (SPEC-008): an action is completed only on a recorded acknowledgement (status `completed` with a
 * resolved seq after the request) and failed only on a recorded failure. Anything else is rendered
 * `in_progress: outcome unknown — verify before retrying`, never as completed.
 *
 * Bound (Q-020 option A, built on timeout; challenge 01a09da8): the Agent State Object keeps one PendingIntent per
 * request ever made in the run, so rendering all of them would overrun any budget on a long run (DEC-005: resume must
 * not scale with run length).
 * - Never dropped: every intent whose outcome is unknown, and every side-effect intent whatever its status. An
 *   external effect that already happened must stay visible (DEC-031).
 * - Bounded: resolved TOOL intents (completed, or failed = pending). Newest first, while their estimated size fits
 *   TIER1_RESOLVED_SHARE of the character budget, stopping at the first that does not. The rest are counted, never
 *   silently dropped: their managed effects are in the Tier 2 workspace commit and the ledger keeps every one.
 */
import type { PendingIntent } from '../model/types.js';
import { compareText, printable } from './text.js';

export const IN_PROGRESS_NOTICE = 'in_progress: outcome unknown — verify before retrying';

/** Share of the character budget that listed resolved tool intents may use. */
export const TIER1_RESOLVED_SHARE = 0.25;

export type RenderedStatus = 'completed' | 'in_progress' | 'pending';

export interface Tier1Intents {
  /** Intents shown in Tier 1, ordered by request seq. */
  readonly listed: readonly PendingIntent[];
  /** Resolved-completed tool intents not listed. */
  readonly omittedCompleted: number;
  /** Resolved-failed tool intents not listed. */
  readonly omittedFailed: number;
  /** request_event_id of every listed intent. */
  readonly listedRequestIds: ReadonlySet<string>;
}

export function renderedStatus(intent: PendingIntent): RenderedStatus {
  if (intent.resolved_seq !== null && intent.resolved_seq > intent.requested_seq) {
    if (intent.status === 'completed') return 'completed';
    if (intent.status === 'pending') return 'pending';
  }
  return 'in_progress';
}

/** Resolved tool intents are the only ones Tier 1 may leave out. */
function isBounded(intent: PendingIntent): boolean {
  return intent.kind === 'tool' && renderedStatus(intent) !== 'in_progress';
}

function compareIntents(a: PendingIntent, b: PendingIntent): number {
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

export function selectTier1Intents(intents: readonly PendingIntent[], ledgerCursor: number, charBudget: number): Tier1Intents {
  const sorted = [...intents].sort(compareIntents);
  const kept = new Set<PendingIntent>(sorted.filter((intent) => !isBounded(intent)));
  const bounded = sorted.filter(isBounded);

  let spent = 0;
  let full = false;
  let omittedCompleted = 0;
  let omittedFailed = 0;
  for (let i = bounded.length - 1; i >= 0; i -= 1) {
    const intent = bounded[i];
    if (intent === undefined) continue;
    // Its entry in state.pending_intent plus its line in the preamble, both as they appear in the JSON.
    const cost = JSON.stringify(intent).length + 1 + JSON.stringify(intentLine(intent, ledgerCursor)).length;
    if (!full && spent + cost <= charBudget) {
      kept.add(intent);
      spent += cost;
    } else {
      full = true;
      if (renderedStatus(intent) === 'completed') omittedCompleted += 1;
      else omittedFailed += 1;
    }
  }

  const listed = sorted.filter((intent) => kept.has(intent));
  return { listed, omittedCompleted, omittedFailed, listedRequestIds: new Set(listed.map((intent) => intent.request_event_id)) };
}

/** The recorded pending intent narrowed to what Tier 1 lists: never-dropped intents, plus bounded ones that are listed. */
export function narrowStateIntents(recorded: readonly PendingIntent[], selection: Tier1Intents): PendingIntent[] {
  return recorded.filter((intent) => !isBounded(intent) || selection.listedRequestIds.has(intent.request_event_id));
}
