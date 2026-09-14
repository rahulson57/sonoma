/**
 * derivePendingIntent — SPEC-004 resume rule, derived purely from ledger acknowledgements.
 *
 * An action counts as COMPLETED only if the ledger holds its acknowledgement: `tool.completed` for a
 * `tool.requested`, or `side_effect.committed` for a `side_effect.requested`. Otherwise:
 * - no acknowledgement and no failure → IN_PROGRESS (it may or may not have run);
 * - `tool.failed` → PENDING (known not done, safe to retry). Never completed.
 * Completion is sticky: a later failure event does not undo a recorded acknowledgement.
 *
 * Requests and acknowledgements are matched by intent id, per kind. An event's intent id is its top-level
 * `intent_id` (SPEC-015 amendment 2). That member is hashed and stays on the event when the payload is
 * offloaded to a blob, so an offloaded acknowledgement still correlates. An event without one (null, or
 * sealed before the amendment) falls back to the payload member named in INTENT_ID_KEYS
 * (`tool_call_id` / `side_effect_id`). Only an acknowledgement recorded AFTER its request counts.
 * A request that carries no id is still reported (intent_id: null) and stays in_progress. An
 * acknowledgement whose id cannot be read is ignored, including an offloaded one with no top-level
 * intent_id. Its intent then stays in_progress. That is the safe direction: an intent is never reported
 * completed on evidence the ledger does not show.
 */
import type { IntentKind, IntentStatus, LedgerEvent, PendingIntent } from '../model/types.js';

/** Payload member that correlates a request with its acknowledgement, per intent kind. */
export const INTENT_ID_KEYS: Readonly<Record<IntentKind, string>> = Object.freeze({
  tool: 'tool_call_id',
  side_effect: 'side_effect_id',
});

type Role = 'request' | 'acknowledgement' | 'failure';

interface Rule {
  readonly kind: IntentKind;
  readonly role: Role;
}

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ['tool.requested', { kind: 'tool', role: 'request' }],
  ['tool.completed', { kind: 'tool', role: 'acknowledgement' }],
  ['tool.failed', { kind: 'tool', role: 'failure' }],
  ['side_effect.requested', { kind: 'side_effect', role: 'request' }],
  ['side_effect.committed', { kind: 'side_effect', role: 'acknowledgement' }],
]);

type MutableIntent = { -readonly [K in keyof PendingIntent]: PendingIntent[K] };

function intentId(event: LedgerEvent, kind: IntentKind): string | null {
  // `?? null`: an event sealed before SPEC-015 has no intent_id member at all.
  const top = event.intent_id ?? null;
  if (typeof top === 'string' && top.length > 0) return top;
  const value = event.payload?.[INTENT_ID_KEYS[kind]];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One entry per request event, in seq order. The input may be in any order. */
export function derivePendingIntent(events: readonly LedgerEvent[]): PendingIntent[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const intents: MutableIntent[] = [];
  const latestById = new Map<string, MutableIntent>();

  for (const event of ordered) {
    const rule = RULES.get(event.type);
    if (!rule) continue;
    const id = intentId(event, rule.kind);

    if (rule.role === 'request') {
      const intent: MutableIntent = {
        kind: rule.kind,
        intent_id: id,
        request_event_id: event.event_id,
        status: 'in_progress',
        requested_seq: event.seq,
        resolved_seq: null,
      };
      intents.push(intent);
      if (id !== null) latestById.set(`${rule.kind}:${id}`, intent);
      continue;
    }

    if (id === null) continue;
    const intent = latestById.get(`${rule.kind}:${id}`);
    if (!intent || intent.status === 'completed') continue;
    const status: IntentStatus = rule.role === 'acknowledgement' ? 'completed' : 'pending';
    intent.status = status;
    intent.resolved_seq = event.seq;
  }

  return intents.map((intent) => Object.freeze({ ...intent }));
}
