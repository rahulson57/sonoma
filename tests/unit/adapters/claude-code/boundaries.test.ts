/**
 * SPEC-009 criterion: Stop and SessionEnd each create exactly one checkpoint; the other hooks create none.
 * Boundary checkpoints are automatic: checkpoint(runId) with no label, so no distillation request (SPEC-002).
 */
import { describe, expect, it, vi } from 'vitest';
import { FIXTURES, fixture, harness, RUN_ID, type FixtureName } from './support.js';

const NON_BOUNDARY: FixtureName[] = [
  FIXTURES.SessionStart,
  FIXTURES.UserPromptSubmit,
  FIXTURES.PreToolUse,
  FIXTURES.PostToolUse,
  FIXTURES.PostToolUseFailure,
  FIXTURES.SessionStartResume,
];

describe('checkpoint boundaries', () => {
  it('SessionStart, UserPromptSubmit, PreToolUse, PostToolUse (and PostToolUseFailure) create no checkpoint', async () => {
    const { engine, handler } = harness({ status: ['', '?? scripts/deploy.ts\0'] });
    for (const name of NON_BOUNDARY) {
      await handler.handleHook(fixture(name));
      expect(engine.checkpoints, name).toEqual([]);
    }
    await handler.handleHook({ hook_event_name: 'Notification', message: 'Claude needs your permission' });
    await handler.handleHook('{not json');
    expect(engine.checkpoints).toEqual([]);
  });

  it.each([
    ['Stop', FIXTURES.Stop],
    ['SessionEnd', FIXTURES.SessionEnd],
  ] as const)('%s creates exactly one checkpoint, unlabelled, after agent.suspended', async (_hook, name) => {
    const { engine, handler } = harness();
    const typesAtCheckpoint: string[][] = [];
    // Bind the real method BEFORE spying, or the mock would call itself.
    const original = engine.checkpoint.bind(engine);
    const checkpoint = vi.spyOn(engine, 'checkpoint');
    checkpoint.mockImplementation(async (runId: string) => {
      typesAtCheckpoint.push([...engine.types]);
      return original(runId);
    });

    await handler.handleHook(fixture(FIXTURES.UserPromptSubmit));
    const id = await handler.handleHook(fixture(name));

    expect(engine.checkpoints).toEqual([RUN_ID]);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    // Exactly one argument: no label, so an automatic checkpoint never requests distillation.
    expect(checkpoint.mock.calls[0]).toEqual([RUN_ID]);
    expect(typesAtCheckpoint).toEqual([['run.created', 'model.requested', 'agent.suspended']]);
    expect(engine.events.find((event) => event.event_id === id)?.type).toBe('agent.suspended');
  });

  it('a full session creates one checkpoint per Stop and per SessionEnd', async () => {
    const { engine, handler } = harness();
    const session: FixtureName[] = [
      FIXTURES.SessionStart,
      FIXTURES.UserPromptSubmit,
      FIXTURES.PreToolUse,
      FIXTURES.PostToolUse,
      FIXTURES.Stop,
      FIXTURES.UserPromptSubmit,
      FIXTURES.PreToolUse,
      FIXTURES.PostToolUseFailure,
      FIXTURES.Stop,
      FIXTURES.SessionEnd,
    ];
    for (const name of session) await handler.handleHook(fixture(name));
    expect(engine.checkpoints).toHaveLength(3);
    expect(engine.types.filter((type) => type === 'agent.suspended')).toHaveLength(3);
  });
});
