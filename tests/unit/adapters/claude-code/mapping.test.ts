/**
 * SPEC-009 criterion: each of the 6 hook fixtures maps to the ledger event type in the mapping table.
 *
 * Expected types are written out here from the SPEC-009 table, not read from the adapter's HOOK_MAPPING, so the test
 * cannot agree with a wrong table. The two engine-owned rows follow challenge 01a09e3c / Q-026 default 1: the first
 * SessionStart resolves to the run.created that run() emitted via startRun(), and a subsequent SessionStart is
 * agent.started.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_OWNED_EVENT_TYPES } from '../../../../src/engine/index.js';
import { FIXTURES, fixture, fixtureText, harness, type FakeEngine, type FixtureName } from './support.js';

function typeOf(engine: FakeEngine, id: string | null): string | undefined {
  return engine.events.find((event) => event.event_id === id)?.type;
}

const SPEC_TABLE: ReadonlyArray<{ hook: string; fixture: FixtureName; type: string }> = [
  { hook: 'SessionStart', fixture: FIXTURES.SessionStart, type: 'run.created' },
  { hook: 'UserPromptSubmit', fixture: FIXTURES.UserPromptSubmit, type: 'model.requested' },
  { hook: 'PreToolUse', fixture: FIXTURES.PreToolUse, type: 'tool.requested' },
  { hook: 'PostToolUse', fixture: FIXTURES.PostToolUse, type: 'tool.completed' },
  { hook: 'Stop', fixture: FIXTURES.Stop, type: 'agent.suspended' },
  { hook: 'SessionEnd', fixture: FIXTURES.SessionEnd, type: 'agent.suspended' },
];

describe('SPEC-009 hook mapping', () => {
  it('each of the 6 hook fixtures, played as one session, maps to the ledger event type in the mapping table', async () => {
    const { engine, handler } = harness();
    for (const row of SPEC_TABLE) {
      const id = await handler.handleHook(fixtureText(row.fixture));
      expect(id, row.hook).not.toBeNull();
      expect(typeOf(engine, id), row.hook).toBe(row.type);
    }
    expect(engine.types).toEqual([
      'run.created',
      'model.requested',
      'tool.requested',
      'tool.completed',
      'agent.suspended',
      'agent.suspended',
    ]);
    // record() was never asked for an engine-owned type.
    expect(engine.drafts.filter((draft) => ENGINE_OWNED_EVENT_TYPES.has(draft.type))).toEqual([]);
  });

  it('the first SessionStart resolves to run.created and appends nothing', async () => {
    const { engine, handler } = harness();
    const id = await handler.handleHook(fixture(FIXTURES.SessionStart));
    expect(id).toBe(engine.events[0]!.event_id);
    expect(engine.types).toEqual(['run.created']);
  });

  it('a subsequent SessionStart (source resume) is agent.started, never the engine-owned agent.resumed', async () => {
    const { engine, handler } = harness();
    await handler.handleHook(fixture(FIXTURES.SessionStart));
    await handler.handleHook(fixture(FIXTURES.UserPromptSubmit));
    const id = await handler.handleHook(fixture(FIXTURES.SessionStartResume));
    expect(typeOf(engine, id)).toBe('agent.started');
    expect(engine.events.at(-1)!.payload).toEqual({ hook: 'SessionStart', source: 'resume', model: null });
  });

  it('accepts the payload as stdin text, as UTF-8 bytes, or already parsed', async () => {
    for (const input of [fixtureText(FIXTURES.UserPromptSubmit), Buffer.from(fixtureText(FIXTURES.UserPromptSubmit)), fixture(FIXTURES.UserPromptSubmit)]) {
      const { engine, handler } = harness();
      expect(typeOf(engine, await handler.handleHook(input))).toBe('model.requested');
      expect(engine.events.at(-1)!.payload).toMatchObject({ prompt: fixture(FIXTURES.UserPromptSubmit)['prompt'] });
    }
  });

  it('PreToolUse → tool.requested and PostToolUse → tool.completed, correlated by intent_id = tool_use_id', async () => {
    const { engine, handler } = harness();
    const requested = await handler.handleHook(fixture(FIXTURES.PreToolUse));
    const completed = await handler.handleHook(fixture(FIXTURES.PostToolUse));
    const toolUseId = fixture(FIXTURES.PreToolUse)['tool_use_id'];
    const byId = (id: string | null) => engine.events.find((event) => event.event_id === id)!;
    expect(byId(requested)).toMatchObject({ type: 'tool.requested', actor: 'agent', intent_id: toolUseId });
    expect(byId(requested).payload).toMatchObject({ tool: 'Write', tool_call_id: toolUseId, input: fixture(FIXTURES.PreToolUse)['tool_input'] });
    expect(byId(completed)).toMatchObject({ type: 'tool.completed', actor: 'runtime', intent_id: toolUseId });
    expect(byId(completed).payload).toMatchObject({ tool: 'Write', response: fixture(FIXTURES.PostToolUse)['tool_response'] });
  });

  it('PostToolUse whose tool_response reports an error → tool.failed', async () => {
    const { engine, handler } = harness();
    const payload = { ...fixture(FIXTURES.PostToolUse), tool_name: 'Read', tool_response: { is_error: true, error: 'EACCES: permission denied' } };
    expect(typeOf(engine, await handler.handleHook(payload))).toBe('tool.failed');
    expect(engine.types).not.toContain('tool.completed');
  });

  it('PostToolUseFailure → tool.failed with the error and is_interrupt', async () => {
    const { engine, handler } = harness();
    const id = await handler.handleHook(fixture(FIXTURES.PostToolUseFailure));
    expect(typeOf(engine, id)).toBe('tool.failed');
    expect(engine.events.at(-1)).toMatchObject({
      intent_id: 'toolu_01Bq4Rt7Ys2Vw8Xz5Ac3Df6Gh',
      payload: { tool: 'Bash', error: 'Command failed with exit code 1', is_interrupt: false },
    });
  });

  describe('workspace.changed', () => {
    it.each(['Write', 'Edit', 'Bash'])('%s: PostToolUse adds workspace.changed after tool.completed when git status differs', async (tool) => {
      const { engine, handler, status } = harness({ status: ['', '?? scripts/deploy.ts\0'] });
      await handler.handleHook({ ...fixture(FIXTURES.PreToolUse), tool_name: tool });
      const completed = await handler.handleHook({ ...fixture(FIXTURES.PostToolUse), tool_name: tool });
      expect(typeOf(engine, completed)).toBe('tool.completed');
      expect(engine.types.slice(1)).toEqual(['tool.requested', 'tool.completed', 'workspace.changed']);
      expect(status.calls).toEqual([engine.workspace, engine.workspace]);
      const changed = engine.events.at(-1)!;
      expect(changed.intent_id).toBe('toolu_01A7c9QbW2xYz3LmNpRsTuVw');
      expect(changed.payload).toMatchObject({ tool, entries: [{ status: '??', path: 'scripts/deploy.ts' }], truncated: false });
      expect(changed.payload!['workspace_status_before']).toBe(engine.events[1]!.payload!['workspace_status']);
    });

    it('no workspace.changed when git status is the same before and after', async () => {
      const { engine, handler } = harness({ status: [' M README.md\0'] });
      await handler.handleHook({ ...fixture(FIXTURES.PreToolUse), tool_name: 'Bash' });
      await handler.handleHook({ ...fixture(FIXTURES.PostToolUse), tool_name: 'Bash' });
      expect(engine.types.slice(1)).toEqual(['tool.requested', 'tool.completed']);
    });

    it('other tools never read git status and never produce workspace.changed', async () => {
      const { engine, handler, status } = harness({ status: ['', '?? changed\0'] });
      await handler.handleHook({ ...fixture(FIXTURES.PreToolUse), tool_name: 'Read' });
      await handler.handleHook({ ...fixture(FIXTURES.PostToolUse), tool_name: 'Read' });
      expect(status.calls).toEqual([]);
      expect(engine.types.slice(1)).toEqual(['tool.requested', 'tool.completed']);
      expect(engine.events[1]!.payload).not.toHaveProperty('workspace_status');
    });

    it('compares against the PreToolUse of the same tool_use_id, even with other calls in between', async () => {
      // Pre A sees a clean tree, Pre B sees x, Post A and Post B both see x: only A changed the workspace.
      const { engine, handler } = harness({ status: ['', '?? x\0', '?? x\0', '?? x\0'] });
      const a = { tool_name: 'Write', tool_use_id: 'toolu_01AaaaaaaaaaaaaaaaaaaaaaaaA' };
      const b = { tool_name: 'Bash', tool_use_id: 'toolu_01BbbbbbbbbbbbbbbbbbbbbbbbB' };
      await handler.handleHook({ ...fixture(FIXTURES.PreToolUse), ...a });
      await handler.handleHook({ ...fixture(FIXTURES.PreToolUse), ...b });
      await handler.handleHook({ ...fixture(FIXTURES.PostToolUse), ...a });
      await handler.handleHook({ ...fixture(FIXTURES.PostToolUse), ...b });
      expect(engine.types.slice(1)).toEqual(['tool.requested', 'tool.requested', 'tool.completed', 'workspace.changed', 'tool.completed']);
      expect(engine.events[4]!.intent_id).toBe(a.tool_use_id);
    });

    it('without a tool_use_id the PreToolUse cannot be identified, so no change is claimed', async () => {
      const { engine, handler } = harness({ status: ['', '?? x\0'] });
      const { tool_use_id: _pre, ...pre } = fixture(FIXTURES.PreToolUse);
      const { tool_use_id: _post, ...post } = fixture(FIXTURES.PostToolUse);
      await handler.handleHook(pre);
      await handler.handleHook(post);
      expect(engine.types.slice(1)).toEqual(['tool.requested', 'tool.completed']);
      expect(engine.events[1]!.intent_id).toBeNull();
    });
  });
});
