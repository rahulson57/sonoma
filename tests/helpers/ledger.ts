/**
 * Fake, deterministic execution-ledger event streams for tests.
 *
 * ─── PLACEHOLDER TYPES ────────────────────────────────────────────────────────────────────────
 * The canonical `LedgerEvent` is owned by S03 (Model & Ledger, SPEC-004, `src/model/**` /
 * `src/ledger/**`), which has not landed. The type below is the SMALLEST local shape these
 * helpers need, using SPEC-004's field names. It deliberately omits `prev_hash` / `hash` /
 * `payload_ref`: the hash chain and canonical JSON belong to S03, which appends these events
 * through its own ledger. When S03 lands, replace this type with an import from `src/model`.
 * Payload shapes are fixture-only and are not a schema.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
import { ALPHABET, pick, randomChars, randomInt, seededRng, type Rng } from './prng.js';

/** The 19 v1 event types, as listed in SPEC-004. Placeholder until S03 exports the enum. */
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
export type LedgerActor = 'agent' | 'runtime' | 'human';

/** PLACEHOLDER for S03's canonical LedgerEvent — see the file header. */
export interface LedgerEvent {
  event_id: string;
  run_id: string;
  /** Strictly increasing per run, starting at 1. */
  seq: number;
  type: LedgerEventType;
  actor: LedgerActor;
  payload: Record<string, unknown>;
}

type Draft = Pick<LedgerEvent, 'type' | 'actor' | 'payload'>;

const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep'] as const;

/** Produces one "episode" of related events; episodes are concatenated and cut at `n`. */
function episode(rng: Rng, counter: { tool: number; model: number; checkpoint: number }): Draft[] {
  const roll = randomInt(rng, 100);
  if (roll < 30) {
    counter.model += 1;
    const request_id = `req_${counter.model}`;
    return [
      { type: 'model.requested', actor: 'agent', payload: { request_id, input_tokens: 100 + randomInt(rng, 4000) } },
      { type: 'model.responded', actor: 'runtime', payload: { request_id, output_tokens: 10 + randomInt(rng, 800) } },
    ];
  }
  if (roll < 70) {
    counter.tool += 1;
    const tool_call_id = `tool_${counter.tool}`;
    const tool = pick(rng, TOOLS);
    const failed = randomInt(rng, 10) === 0;
    return [
      { type: 'tool.requested', actor: 'agent', payload: { tool_call_id, tool, input: { path: `src/file-${randomInt(rng, 500)}.ts` } } },
      failed
        ? { type: 'tool.failed', actor: 'runtime', payload: { tool_call_id, error: 'fake tool failure' } }
        : { type: 'tool.completed', actor: 'runtime', payload: { tool_call_id, exit_code: 0, stdout_bytes: randomInt(rng, 65536) } },
    ];
  }
  if (roll < 85) {
    return [{ type: 'workspace.changed', actor: 'runtime', payload: { paths: [`src/file-${randomInt(rng, 500)}.ts`] } }];
  }
  if (roll < 95) {
    return [{ type: 'context.built', actor: 'runtime', payload: { tokens: 1000 + randomInt(rng, 30000) } }];
  }
  counter.checkpoint += 1;
  return [{ type: 'checkpoint.created', actor: 'runtime', payload: { checkpoint_id: `c_${counter.checkpoint}` } }];
}

/**
 * Generate `n` fake ledger events for one run. Pure function of `(n, seed)`: equal inputs give
 * deep-equal output, and `fakeLedgerEvents(k, s)` is a prefix of `fakeLedgerEvents(n, s)` for k <= n.
 * A stream cut mid-episode can end with a `tool.requested` that has no acknowledgement, which is
 * the pending-intent case consumers need.
 */
export function fakeLedgerEvents(n: number, seed = 1): LedgerEvent[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`fakeLedgerEvents: n must be a non-negative integer, got ${String(n)}`);
  }
  const rng = seededRng(seed);
  const run_id = `run_${randomChars(rng, ALPHABET.crockford, 26)}`;
  const counter = { tool: 0, model: 0, checkpoint: 0 };
  const events: LedgerEvent[] = [];
  const push = (draft: Draft): void => {
    events.push({
      event_id: `evt_${randomChars(rng, ALPHABET.crockford, 26)}`,
      run_id,
      seq: events.length + 1,
      ...draft,
    });
  };

  const opening: Draft[] = [
    { type: 'run.created', actor: 'runtime', payload: { agent: 'claude-code' } },
    { type: 'agent.started', actor: 'runtime', payload: {} },
  ];
  for (const draft of opening) {
    if (events.length >= n) return events;
    push(draft);
  }
  while (events.length < n) {
    for (const draft of episode(rng, counter)) {
      if (events.length >= n) break;
      push(draft);
    }
  }
  return events;
}
