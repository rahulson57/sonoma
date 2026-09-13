/**
 * Execution Ledger event types and actors — SPEC-004 "Event types (v1)".
 *
 * This list IS the enum. `schema/ledger-event.schema.json` carries the same list, and
 * tests/unit/model/schema.test.ts asserts the two are identical so they cannot drift apart.
 * The ledger never accepts a type outside this list (SPEC-004 "Must never"); adding one is a
 * schema change, not something an adapter may do on its own.
 */

/** The 19 v1 event types, in SPEC-004 order. */
export const LEDGER_EVENT_TYPES = [
  'run.created',
  'agent.started',
  'context.built',
  'model.requested',
  'model.responded',
  'tool.requested',
  'tool.completed',
  'tool.failed',
  'workspace.changed',
  'workspace.file_skipped',
  'side_effect.requested',
  'side_effect.committed',
  'checkpoint.created',
  'agent.interrupted',
  'agent.resumed',
  'agent.forked',
  'agent.rolled_back',
  'distill.completed',
  'export.unsafe',
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

/** Who caused an event (SPEC-004 LedgerEvent.actor). */
export const LEDGER_ACTORS = ['agent', 'runtime', 'human'] as const;

export type LedgerActor = (typeof LEDGER_ACTORS)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(LEDGER_EVENT_TYPES);
const ACTOR_SET: ReadonlySet<string> = new Set(LEDGER_ACTORS);

export function isLedgerEventType(value: unknown): value is LedgerEventType {
  return typeof value === 'string' && EVENT_TYPE_SET.has(value);
}

export function isLedgerActor(value: unknown): value is LedgerActor {
  return typeof value === 'string' && ACTOR_SET.has(value);
}
