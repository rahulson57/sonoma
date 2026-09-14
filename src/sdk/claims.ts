/**
 * How a validated declaration becomes ledger and claim shapes (SPEC-010 "Returns"). Pure: it builds values and
 * writes nothing.
 * - One `state.declared` observation per save(): actor 'agent', payload = the declared fields.
 * - One SemanticClaim per declared value. Origin is always 'agent_declared', and provenance.event_ids holds exactly the
 *   id of the `state.declared` event the Engine appended for that call, so provenance is never empty.
 */
import type { LedgerEventDraft, SemanticClaim, SemanticField } from '../model/types.js';
import { LIST_FIELDS, SCALAR_FIELDS, type DeclaredState } from './validate.js';

export const DECLARED_EVENT_TYPE = 'state.declared';
export const DECLARED_CLAIM_ORIGIN = 'agent_declared';

/** DeclaredStateInput member → SemanticClaim field. The claim field enum is singular (DEC-017). */
export const CLAIM_FIELD_OF = {
  goal: 'goal',
  current_step: 'current_step',
  next_action: 'next_action',
  decisions: 'decision',
  assumptions: 'assumption',
} as const satisfies Record<keyof DeclaredState, SemanticField>;

/** The `state.declared` observation for one save(). Lists are copied, so the draft never aliases caller arrays. */
export function declaredStateDraft(runId: string, state: DeclaredState): LedgerEventDraft {
  const payload: Record<string, string | string[]> = {};
  for (const field of SCALAR_FIELDS) {
    const value = state[field];
    if (value !== undefined) payload[field] = value;
  }
  for (const field of LIST_FIELDS) {
    const value = state[field];
    if (value !== undefined) payload[field] = [...value];
  }
  return { run_id: runId, type: DECLARED_EVENT_TYPE, actor: 'agent', payload };
}

/**
 * One agent_declared claim per declared value, in field order (goal, current_step, next_action, then each decision,
 * then each assumption), each citing `eventId`, the sealed `state.declared` event of this save().
 */
export function declaredClaims(state: DeclaredState, eventId: string): SemanticClaim[] {
  if (typeof eventId !== 'string' || eventId === '') {
    throw new TypeError('declaredClaims needs the non-empty event_id of the state.declared event');
  }
  const claim = (field: SemanticField, value: string): SemanticClaim => ({
    field,
    value,
    origin: DECLARED_CLAIM_ORIGIN,
    provenance: { event_ids: [eventId], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] },
  });
  const claims: SemanticClaim[] = [];
  for (const field of SCALAR_FIELDS) {
    const value = state[field];
    if (value !== undefined) claims.push(claim(CLAIM_FIELD_OF[field], value));
  }
  for (const field of LIST_FIELDS) {
    for (const value of state[field] ?? []) claims.push(claim(CLAIM_FIELD_OF[field], value));
  }
  return claims;
}
