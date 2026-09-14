/**
 * SPEC-009 criterion: no ObservationEvent produced by the adapter contains goal, plan, decisions, assumptions or
 * next_action fields. Semantic state comes from the State SDK or the Distiller, never from the adapter.
 *
 * Forbidden names are SPEC-009's list united with the model's SEMANTIC_FIELDS (which spells decision/assumption in the
 * singular and adds current_step, current_state and open_question), Q-026 default 6. They are checked as keys at any
 * depth of every event the adapter appends.
 */
import { describe, expect, it } from 'vitest';
import { SEMANTIC_FIELDS } from '../../../../src/model/types.js';
import { FIXTURES, fixture, harness, keysDeep, type FixtureName } from './support.js';

const FORBIDDEN: ReadonlySet<string> = new Set(['goal', 'plan', 'decisions', 'assumptions', 'next_action', ...SEMANTIC_FIELDS]);

const EVERY_FIXTURE: FixtureName[] = [
  FIXTURES.SessionStart,
  FIXTURES.UserPromptSubmit,
  FIXTURES.PreToolUse,
  FIXTURES.PostToolUse,
  FIXTURES.PostToolUseFailure,
  FIXTURES.SessionStartResume,
  FIXTURES.Stop,
  FIXTURES.SessionEnd,
];

describe('observed state only', () => {
  it('no event from any hook fixture, error or unknown hook carries a semantic field at any depth', async () => {
    const { engine, handler } = harness({ status: ['', '?? scripts/deploy.ts\0'] });
    for (const name of EVERY_FIXTURE) await handler.handleHook(fixture(name));
    await handler.handleHook({ ...fixture(FIXTURES.PostToolUse), tool_name: 'Read', tool_response: { is_error: true, error: 'nope' } });
    await handler.handleHook({ hook_event_name: 'Notification', message: 'waiting for input' });
    await handler.handleHook('{broken');

    const observed = engine.observed;
    expect(new Set(observed.map((event) => event.type))).toEqual(
      new Set(['model.requested', 'tool.requested', 'tool.completed', 'workspace.changed', 'tool.failed', 'agent.started', 'agent.suspended', 'adapter.unknown_hook', 'adapter.error']),
    );
    for (const event of observed) {
      expect(keysDeep(event).filter(({ key }) => FORBIDDEN.has(key)), event.type).toEqual([]);
    }
    // Nothing the adapter appends declares state.
    expect(observed.map((event) => event.type)).not.toContain('state.declared');
  });

  it("Stop's last_assistant_message is not recorded, so no agent prose reaches the ledger through the adapter", async () => {
    const { engine, handler } = harness();
    await handler.handleHook(fixture(FIXTURES.Stop));
    const ledger = JSON.stringify(engine.events);
    expect(ledger).not.toContain('last_assistant_message');
    expect(ledger).not.toContain(String(fixture(FIXTURES.Stop)['last_assistant_message']));
    expect(engine.events.at(-1)!.payload).toEqual({ hook: 'Stop', stop_hook_active: false });
  });

  it('tool data that happens to use a semantic key stays raw tool input, never lifted into an adapter field', async () => {
    const { engine, handler } = harness();
    const plan = '1. add flag\n2. update tests';
    await handler.handleHook({ ...fixture(FIXTURES.PreToolUse), tool_name: 'ExitPlanMode', tool_input: { plan } });
    const hits = keysDeep(engine.events.at(-1)).filter(({ key }) => FORBIDDEN.has(key));
    expect(hits).toEqual([{ key: 'plan', path: '/payload/input/plan' }]);
    expect(Object.keys(engine.events.at(-1)!.payload!).sort()).toEqual(['hook', 'input', 'tool', 'tool_call_id']);
  });
});
