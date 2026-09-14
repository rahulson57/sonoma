/**
 * distill() — SPEC-007. One explicitly triggered distillation of one checkpoint:
 *
 *   request + budget checks → state object + ledger delta (seq in (prev, cursor]) → redacted prompt →
 *   provider → claim validation (bad claims dropped and counted) → projection validated against
 *   schema/semantic-projection.schema.json → stored as a new projection.
 *
 * Nothing here writes the ledger, the Agent State Object or a git ref. Callers decide WHEN to distill
 * (see triggers.ts): never on an automatic checkpoint, never on plain resume.
 */
import { randomUUID } from 'node:crypto';
import { SHA256_HEX } from '../ledger/hash.js';
import type { SemanticProjection } from '../model/types.js';
import { validateSemanticProjection } from '../model/validate.js';
import { assertBudgetAvailable, chargeBudget } from './budget.js';
import { DistillError } from './errors.js';
import { buildPrompt, eventsInRange, type PromptEvent } from './prompt.js';
import type { ProjectionStore } from './projection-store.js';
import { parseClaims, validateClaims } from './provenance.js';
import {
  PROMPT_VERSION,
  type DistillBudget,
  type DistillEvent,
  type DistillRequest,
  type DistillResult,
  type DistillSource,
  type DistillerProvider,
  type ProviderUsage,
} from './types.js';

export interface DistillDeps {
  readonly provider: DistillerProvider;
  readonly source: DistillSource;
  readonly store: ProjectionStore;
  /** The run's budget before this distillation. */
  readonly budget: DistillBudget;
  /** Epoch milliseconds for `createdAt`. Tests inject tests/helpers/clock.ts. */
  readonly clock?: { now(): number };
  /** Defaults to `proj_<uuid>`. */
  readonly newProjectionId?: () => string;
}

/** Mirrors common.schema.json CheckpointId and GitSha. */
const CHECKPOINT_ID = /^c_[1-9][0-9]*$/;
const GIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function invalid(message: string): DistillError {
  return new DistillError('DISTILL_INVALID_REQUEST', message);
}

function assertRequest(request: DistillRequest): void {
  if (typeof request !== 'object' || request === null) throw invalid('a DistillRequest is {checkpointId, stateHash, ledgerRange, workspaceCommit}');
  if (typeof request.checkpointId !== 'string' || !CHECKPOINT_ID.test(request.checkpointId)) {
    throw invalid(`checkpointId ${JSON.stringify(request.checkpointId)} is not c_<n>`);
  }
  if (typeof request.stateHash !== 'string' || !SHA256_HEX.test(request.stateHash)) throw invalid('stateHash is a lowercase hex sha256');
  if (typeof request.workspaceCommit !== 'string' || !GIT_SHA.test(request.workspaceCommit)) {
    throw invalid('workspaceCommit is a lowercase hex git object id');
  }
  const range: unknown = request.ledgerRange;
  if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isSafeInteger(n) && n >= 0) || range[0] > range[1]) {
    throw invalid(`ledgerRange ${JSON.stringify(range)} is [previous cursor, cursor] with 0 <= previous <= cursor`);
  }
}

function assertProvider(provider: DistillerProvider): void {
  if (typeof provider !== 'object' || provider === null || typeof provider.complete !== 'function') {
    throw invalid('provider must implement complete(prompt)');
  }
  if (typeof provider.name !== 'string' || provider.name === '' || typeof provider.model !== 'string' || provider.model === '') {
    throw invalid('provider needs a non-empty name and model (both are recorded on the projection)');
  }
}

function checkUsage(usage: unknown): ProviderUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const { inputTokens, outputTokens, costUsd } = usage as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!count(inputTokens) || !count(outputTokens) || typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return null;
  return { inputTokens, outputTokens, costUsd };
}

/** The payload of an event as the prompt shows it: inline, or read from its (already sanitized) CAS blob. */
async function resolveEvent(event: DistillEvent, source: DistillSource): Promise<PromptEvent> {
  const ref = event.payload_ref ?? null;
  let payload: unknown = event.payload;
  if (event.payload === null && ref !== null) {
    const text = Buffer.from(await source.readBlob(ref)).toString('utf8');
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return {
    event_id: event.event_id,
    seq: event.seq,
    type: event.type,
    actor: event.actor,
    ...(event.ts === undefined ? {} : { ts: event.ts }),
    payload,
    payload_ref: ref === null ? null : ref.sha256,
  };
}

export async function distill(request: DistillRequest, deps: DistillDeps): Promise<DistillResult> {
  const { provider, source, store, budget } = deps;
  assertRequest(request);
  assertProvider(provider);
  // Budget before any read, and always before the provider (SPEC-007).
  assertBudgetAvailable(budget);
  if (budget.runId !== source.runId) throw invalid(`budget of ${budget.runId} used to distill a checkpoint of ${source.runId}`);

  const [from, to] = request.ledgerRange;
  const { stateHash, state } = await source.readState(request.checkpointId);
  // Both ends of ledgerRange come from the store, not the caller. The upper end is the checkpoint's cursor.
  // The lower end is its parent's cursor, or 0 for a run's first checkpoint: a fork's first checkpoint has no
  // parent and its run starts at seq 1. A caller can neither widen the delta towards the full run trajectory
  // nor narrow it.
  const checkpoint = await source.readCheckpoint(request.checkpointId);
  const parent = checkpoint.parent_checkpoint_id === null ? null : await source.readCheckpoint(checkpoint.parent_checkpoint_id);
  const previousCursor = parent === null ? 0 : parent.ledger_seq;
  const mismatches = [
    stateHash !== request.stateHash ? `stateHash is ${stateHash}` : null,
    state.checkpoint_id !== request.checkpointId || state.run_id !== source.runId ? `state belongs to ${state.run_id}/${state.checkpoint_id}` : null,
    checkpoint.checkpoint_id !== request.checkpointId ? `checkpoint record belongs to ${checkpoint.checkpoint_id}` : null,
    state.workspace_commit !== request.workspaceCommit ? `workspaceCommit is ${state.workspace_commit}` : null,
    state.ledger_seq !== to ? `the checkpoint cursor is ${state.ledger_seq}, not ${to}` : null,
    from !== previousCursor
      ? parent === null
        ? `ledgerRange starts at ${from}, but ${request.checkpointId} is the first checkpoint of its run, so it starts at 0`
        : `ledgerRange starts at ${from}, but the parent checkpoint ${parent.checkpoint_id} has cursor ${previousCursor}`
      : null,
  ].filter((m): m is string => m !== null);
  if (mismatches.length > 0) {
    throw new DistillError('DISTILL_INPUT_MISMATCH', `request does not match ${source.runId}/${request.checkpointId}: ${mismatches.join('; ')}`);
  }

  // Input bounding: only (previous cursor, cursor], re-checked whatever the source returned.
  const delta = from === to ? [] : eventsInRange(await source.readEvents({ fromSeq: from + 1, toSeq: to }), request.ledgerRange);
  const events: PromptEvent[] = [];
  for (const event of delta) events.push(await resolveEvent(event, source));
  const artifactRefs = [stateHash, ...events.flatMap((event) => (event.payload_ref === null ? [] : [event.payload_ref]))];

  const prompt = buildPrompt({ request, state, events, artifactRefs });
  const response = await provider.complete(prompt);

  const usage = checkUsage(response?.usage);
  if (usage === null) throw new DistillError('DISTILL_INVALID_OUTPUT', 'provider usage is not {inputTokens, outputTokens, costUsd} with non-negative numbers');
  const parsed = parseClaims(typeof response.text === 'string' ? response.text : '');
  if (!parsed.ok) throw new DistillError('DISTILL_INVALID_OUTPUT', parsed.reason, { usage });

  const { claims, rejectedClaims } = await validateClaims(parsed.claims, {
    eventIds: new Set(events.map((event) => event.event_id)),
    artifactRefs: new Set(artifactRefs),
    hasCheckpoint: (id) => source.hasCheckpoint(id),
  });

  const now = (deps.clock ?? { now: () => Date.now() }).now();
  const projection: SemanticProjection = {
    id: (deps.newProjectionId ?? (() => `proj_${randomUUID()}`))(),
    checkpointId: request.checkpointId,
    distiller: { provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION },
    input: { stateHash, ledgerRange: [from, to], workspaceCommit: request.workspaceCommit },
    claims,
    usage,
    createdAt: new Date(now).toISOString(),
  };
  const valid = validateSemanticProjection(projection);
  if (!valid.ok) throw new DistillError('DISTILL_INVALID_PROJECTION', valid.errors.join('; '), { usage });

  await store.put(projection);
  return { projection, rejectedClaims, budget: chargeBudget(budget, usage) };
}
