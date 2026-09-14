/** SPEC-010 "Returns": a declaration becomes one state.declared draft and agent_declared claims citing its event. */
import { describe, expect, it } from 'vitest';
import { validateSemanticClaim } from '../../../src/model/validate.js';
import { CLAIM_FIELD_OF, declaredClaims, declaredStateDraft } from '../../../src/sdk/claims.js';
import { validateDeclaredState } from '../../../src/sdk/validate.js';

const EVENT_ID = 'evt_00000000-0000-4000-8000-000000000001';

describe('declaredClaims', () => {
  it('wraps goal and next_action as agent_declared claims whose provenance cites only the state.declared event', () => {
    const claims = declaredClaims(validateDeclaredState({ goal: 'ship the SDK', next_action: 'write tests' }), EVENT_ID);
    expect(claims).toEqual([
      {
        field: 'goal',
        value: 'ship the SDK',
        origin: 'agent_declared',
        provenance: { event_ids: [EVENT_ID], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] },
      },
      {
        field: 'next_action',
        value: 'write tests',
        origin: 'agent_declared',
        provenance: { event_ids: [EVENT_ID], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] },
      },
    ]);
  });

  it('emits one claim per list entry, mapped to the singular claim field, in field then entry order', () => {
    const state = validateDeclaredState({
      assumptions: ['a1', 'a2'],
      decisions: ['d1', 'd2', 'd3'],
      current_step: 'step',
      goal: 'g',
    });
    const claims = declaredClaims(state, EVENT_ID);
    expect(claims.map((c) => [c.field, c.value])).toEqual([
      ['goal', 'g'],
      ['current_step', 'step'],
      ['decision', 'd1'],
      ['decision', 'd2'],
      ['decision', 'd3'],
      ['assumption', 'a1'],
      ['assumption', 'a2'],
    ]);
    expect(CLAIM_FIELD_OF).toEqual({
      goal: 'goal',
      current_step: 'current_step',
      next_action: 'next_action',
      decisions: 'decision',
      assumptions: 'assumption',
    });
  });

  it('every claim passes the canonical SemanticClaim schema, including an empty-string value', () => {
    const state = validateDeclaredState({ goal: '', current_step: 's', next_action: 'n', decisions: ['d'], assumptions: ['a'] });
    for (const claim of declaredClaims(state, EVENT_ID)) {
      expect(validateSemanticClaim(claim)).toEqual({ ok: true, value: claim });
      expect(claim.origin).toBe('agent_declared');
      expect(claim.provenance.event_ids).toEqual([EVENT_ID]);
    }
  });

  it.each([[''], [undefined as unknown as string], [42 as unknown as string]])('refuses a missing event id (%s)', (eventId) => {
    expect(() => declaredClaims(validateDeclaredState({ goal: 'g' }), eventId)).toThrow(TypeError);
  });

  it('claims built for one call share no arrays with another call', () => {
    const state = validateDeclaredState({ goal: 'g', decisions: ['d'] });
    const first = declaredClaims(state, EVENT_ID);
    const second = declaredClaims(state, 'evt_other');
    expect(first[0]?.provenance.event_ids).toEqual([EVENT_ID]);
    expect(second[0]?.provenance.event_ids).toEqual(['evt_other']);
    expect(first[0]?.provenance).not.toBe(second[0]?.provenance);
  });
});

describe('declaredStateDraft', () => {
  it('is a state.declared observation by the agent carrying exactly the declared fields', () => {
    const state = validateDeclaredState({ goal: 'g', decisions: ['d1'], assumptions: [] });
    expect(declaredStateDraft('run_01J0000000000000000000000A', state)).toEqual({
      run_id: 'run_01J0000000000000000000000A',
      type: 'state.declared',
      actor: 'agent',
      payload: { goal: 'g', decisions: ['d1'] },
    });
  });

  it('copies lists, so later changes to the validated state never reach the draft', () => {
    const decisions = ['d1'];
    const state = validateDeclaredState({ decisions });
    const draft = declaredStateDraft('run_01J0000000000000000000000A', state);
    decisions.push('d2');
    (state.decisions as string[]).push('d3');
    expect(draft.payload).toEqual({ decisions: ['d1'] });
  });
});
