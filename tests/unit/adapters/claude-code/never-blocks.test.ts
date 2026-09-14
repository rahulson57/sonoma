/**
 * SPEC-009 criterion: a malformed or unknown hook payload makes handleHook exit 0 and append adapter.error or
 * adapter.unknown_hook. More generally, handleHook never rejects: a failure while recording, reading git status or
 * checkpointing is recorded as adapter.error, and the `ckpt hook` process exits 0 on whatever it resolves to.
 * DEC-044: an unbound invocation writes and prints nothing; a lock that never frees costs one handleHook invocation at
 * most MAX_LOCK_WAIT_MS (≤ 5 s) of waiting in total, however many writes, checkpoints and adapter.error attempts it
 * makes; and a lost observation is reported as one stderr line that carries no payload data.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCK_RETRY,
  LOCK_RETRY_DELAY_MS,
  MAX_LOCK_WAIT_MS,
  RUN_ID_ENV,
  boundRunId,
  createHookHandler,
} from '../../../../src/adapters/claude-code/index.js';
import { StorageError } from '../../../../src/storage/errors.js';
import { FakeEngine, FIXTURES, fixture, harness, RUN_ID, scriptedStatus } from './support.js';

describe('handleHook never blocks the agent', () => {
  it.each([
    ['text that is not JSON', '{"hook_event_name": "PreToolUse", '],
    ['a JSON array', '[1, 2, 3]'],
    ['a JSON string', '"PreToolUse"'],
    ['bytes that are not UTF-8 JSON', new Uint8Array([0xff, 0xfe, 0x00])],
    ['an object with no hook_event_name', { session_id: 'abc', tool_name: 'Bash' }],
    ['a non-string hook_event_name', { hook_event_name: 7 }],
    ['PreToolUse without tool_name', { hook_event_name: 'PreToolUse', tool_input: { command: 'ls' } }],
    ['PostToolUse with an empty tool_name', { hook_event_name: 'PostToolUse', tool_name: '' }],
    ['UserPromptSubmit without prompt', { hook_event_name: 'UserPromptSubmit' }],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
  ])('malformed payload (%s) resolves and appends adapter.error', async (_label, payload) => {
    const { engine, handler, stderr } = harness();
    const id = await handler.handleHook(payload);
    expect(id).toBe(engine.events.at(-1)!.event_id);
    expect(engine.types).toEqual(['run.created', 'adapter.error']);
    expect(engine.events.at(-1)!.payload).toMatchObject({ hook: null, stage: 'parse' });
    expect(engine.checkpoints).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it('an unknown hook name resolves and appends adapter.unknown_hook with the hook name and field names', async () => {
    const { engine, handler } = harness();
    const id = await handler.handleHook(JSON.stringify({ session_id: 's', hook_event_name: 'PreCompact', trigger: 'auto' }));
    expect(id).toBe(engine.events.at(-1)!.event_id);
    expect(engine.types).toEqual(['run.created', 'adapter.unknown_hook']);
    expect(engine.events.at(-1)!.payload).toEqual({ hook_event_name: 'PreCompact', fields: ['hook_event_name', 'session_id', 'trigger'] });
  });

  it('a payload the engine refuses to record becomes adapter.error for that hook', async () => {
    const { engine, handler } = harness();
    engine.failRecord = (draft) => (draft.type === 'tool.requested' ? new Error('ENOSPC: no space left on device') : undefined);
    const id = await handler.handleHook(fixture(FIXTURES.PreToolUse));
    expect(id).toBe(engine.events.at(-1)!.event_id);
    expect(engine.types).toEqual(['run.created', 'adapter.error']);
    expect(engine.events.at(-1)!.payload).toEqual({ hook: 'PreToolUse', stage: 'record', error: 'Error: ENOSPC: no space left on device' });
  });

  it('a failed boundary checkpoint keeps agent.suspended and appends adapter.error', async () => {
    const { engine, handler } = harness();
    engine.failCheckpoint = () => Object.assign(new Error('the workspace is missing'), { code: 'ERR_WORKSPACE' });
    const id = await handler.handleHook(fixture(FIXTURES.Stop));
    expect(engine.types).toEqual(['run.created', 'agent.suspended', 'adapter.error']);
    expect(id).toBe(engine.events[1]!.event_id);
    expect(engine.events.at(-1)!.payload).toEqual({ hook: 'Stop', stage: 'checkpoint', error: 'ERR_WORKSPACE: the workspace is missing' });
  });

  it('an unreadable git status still records the tool call, then adapter.error', async () => {
    const engine = new FakeEngine();
    const handler = createHookHandler({
      engine,
      ledger: engine,
      env: { [RUN_ID_ENV]: RUN_ID },
      readWorkspaceStatus: async () => {
        throw new Error('fatal: not a git repository');
      },
    });
    await handler.handleHook(fixture(FIXTURES.PreToolUse));
    await handler.handleHook(fixture(FIXTURES.PostToolUse));
    expect(engine.types).toEqual(['run.created', 'tool.requested', 'adapter.error', 'tool.completed', 'adapter.error']);
    expect(engine.events[1]!.payload).not.toHaveProperty('workspace_status');
    expect(engine.events[2]!.payload).toMatchObject({ hook: 'PreToolUse', stage: 'workspace_status' });
  });

  describe('run lock held by another hook process (ERR_RUN_LOCKED)', () => {
    const locked = () => new StorageError('ERR_RUN_LOCKED', 'held by another hook process');

    /** A sleep that only adds up what it was asked to wait. */
    function countingSleep() {
      const counter = {
        waited: 0,
        sleep: async (ms: number) => {
          counter.waited += ms;
        },
      };
      return counter;
    }

    it('the default retry waits a fixed delay, the whole invocation capped by an exported constant of at most 5 s', () => {
      expect(MAX_LOCK_WAIT_MS).toBeLessThanOrEqual(5000);
      expect(LOCK_RETRY_DELAY_MS).toBeGreaterThan(0);
      expect(DEFAULT_LOCK_RETRY).toEqual({ maxWaitMs: MAX_LOCK_WAIT_MS, delayMs: LOCK_RETRY_DELAY_MS });
    });

    it.each([
      ['a zero delay', { maxWaitMs: 100, delayMs: 0 }],
      ['a negative budget', { maxWaitMs: -1, delayMs: 50 }],
      ['a non-finite budget', { maxWaitMs: Number.POSITIVE_INFINITY, delayMs: 50 }],
    ])('refuses a retry policy with %s', (_label, lockRetry) => {
      const engine = new FakeEngine();
      expect(() => createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, lockRetry })).toThrow(TypeError);
    });

    it('retries with the fixed delay while the lock is held, then records', async () => {
      const engine = new FakeEngine();
      let refusals = 0;
      engine.failRecord = () => (refusals++ < 2 ? new StorageError('ERR_RUN_LOCKED', `run ${RUN_ID} already has a writer`) : undefined);
      const sleep = vi.fn(async (_ms: number) => undefined);
      const handler = createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, readWorkspaceStatus: scriptedStatus(['']), sleep });
      await handler.handleHook(fixture(FIXTURES.UserPromptSubmit));
      expect(engine.types).toEqual(['run.created', 'model.requested']);
      expect(sleep.mock.calls).toEqual([[LOCK_RETRY_DELAY_MS], [LOCK_RETRY_DELAY_MS]]);
    });

    it('with the default policy, a lock that never frees costs one invocation at most MAX_LOCK_WAIT_MS in total', async () => {
      const engine = new FakeEngine();
      engine.failRecord = () => locked();
      const clock = countingSleep();
      const stderr: string[] = [];
      const handler = createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, sleep: clock.sleep, stderr: (line) => stderr.push(line) });
      await expect(handler.handleHook(fixture(FIXTURES.UserPromptSubmit))).resolves.toBeNull();
      // The hook's own event and the adapter.error attempt share one budget.
      expect(clock.waited).toBeLessThanOrEqual(MAX_LOCK_WAIT_MS);
      expect(clock.waited).toBeGreaterThan(MAX_LOCK_WAIT_MS - LOCK_RETRY_DELAY_MS);
      expect(engine.drafts.map((draft) => draft.type).filter((type) => type === 'adapter.error')).toHaveLength(1);
      expect(stderr).toHaveLength(1);
    });

    it('worst case PostToolUse(Write): tool.completed takes the whole budget; workspace.changed and adapter.error get one attempt each and no more wait', async () => {
      const engine = new FakeEngine();
      const clock = countingSleep();
      const stderr: string[] = [];
      const handler = createHookHandler({
        engine,
        ledger: engine,
        env: { [RUN_ID_ENV]: RUN_ID },
        readWorkspaceStatus: scriptedStatus(['', '?? scripts/deploy.ts\0']),
        sleep: clock.sleep,
        stderr: (line) => stderr.push(line),
      });
      await handler.handleHook(fixture(FIXTURES.PreToolUse));
      expect(clock.waited).toBe(0);

      // tool.completed gets the lock on the last attempt the budget allows; nothing after it ever does.
      engine.failRecord = (draft) => (draft.type !== 'tool.completed' || clock.waited < MAX_LOCK_WAIT_MS ? locked() : undefined);
      const id = await handler.handleHook(fixture(FIXTURES.PostToolUse));

      expect(clock.waited).toBeLessThanOrEqual(MAX_LOCK_WAIT_MS);
      expect(engine.types).toEqual(['run.created', 'tool.requested', 'tool.completed']);
      const attempts = engine.drafts.slice(1).map((draft) => draft.type);
      expect(attempts.filter((type) => type === 'workspace.changed')).toHaveLength(1);
      expect(attempts.filter((type) => type === 'adapter.error')).toHaveLength(1);
      // tool.completed WAS appended, so it stays the result.
      expect(id).toBe(engine.events.at(-1)!.event_id);
      expect(stderr).toEqual(['ckpt hook PostToolUse: observation not recorded (ERR_RUN_LOCKED)\n']);
    });

    it('worst case Stop: agent.suspended takes the whole budget; the checkpoint and adapter.error get one attempt each and no more wait', async () => {
      const engine = new FakeEngine();
      const clock = countingSleep();
      const stderr: string[] = [];
      const handler = createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, sleep: clock.sleep, stderr: (line) => stderr.push(line) });
      engine.failRecord = (draft) => (draft.type !== 'agent.suspended' || clock.waited < MAX_LOCK_WAIT_MS ? locked() : undefined);
      let checkpointAttempts = 0;
      engine.failCheckpoint = () => {
        checkpointAttempts += 1;
        return locked();
      };

      const id = await handler.handleHook(fixture(FIXTURES.Stop));

      expect(clock.waited).toBeLessThanOrEqual(MAX_LOCK_WAIT_MS);
      expect(engine.types).toEqual(['run.created', 'agent.suspended']);
      expect(engine.checkpoints).toEqual([]);
      expect(checkpointAttempts).toBe(1);
      expect(engine.drafts.map((draft) => draft.type).filter((type) => type === 'adapter.error')).toHaveLength(1);
      expect(id).toBe(engine.events.at(-1)!.event_id);
      expect(stderr).toEqual(['ckpt hook Stop: observation not recorded (ERR_RUN_LOCKED)\n']);
    });

    it('the budget belongs to one invocation: the next hook waits for the lock again', async () => {
      const engine = new FakeEngine();
      const clock = countingSleep();
      const handler = createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, sleep: clock.sleep, stderr: () => undefined });
      engine.failRecord = () => locked();
      await expect(handler.handleHook(fixture(FIXTURES.UserPromptSubmit))).resolves.toBeNull();
      const spent = clock.waited;
      expect(spent).toBeGreaterThan(MAX_LOCK_WAIT_MS - LOCK_RETRY_DELAY_MS);

      let refusals = 0;
      engine.failRecord = () => (refusals++ < 2 ? locked() : undefined);
      const id = await handler.handleHook(fixture(FIXTURES.UserPromptSubmit));
      expect(engine.types).toEqual(['run.created', 'model.requested']);
      expect(id).toBe(engine.events.at(-1)!.event_id);
      expect(clock.waited - spent).toBe(2 * LOCK_RETRY_DELAY_MS);
    });

    it('when even adapter.error cannot be appended: resolves null, one stderr line with no payload data, nothing appended', async () => {
      const engine = new FakeEngine();
      engine.failRecord = () => new StorageError('ERR_RUN_LOCKED', 'held by another process');
      const stderr: string[] = [];
      const handler = createHookHandler({
        engine,
        ledger: engine,
        env: { [RUN_ID_ENV]: RUN_ID },
        lockRetry: { maxWaitMs: 100, delayMs: 50 },
        sleep: async () => undefined,
        stderr: (line) => stderr.push(line),
      });
      const prompt = { ...fixture(FIXTURES.UserPromptSubmit), prompt: 'my token is ghp_notReallyASecretButPayloadData' };
      await expect(handler.handleHook(prompt)).resolves.toBeNull();
      await expect(handler.handleHook(fixture(FIXTURES.Stop))).resolves.toBeNull();
      await expect(handler.handleHook('garbage')).resolves.toBeNull();
      expect(engine.types).toEqual(['run.created']);
      expect(engine.checkpoints).toEqual([]);
      expect(stderr).toEqual([
        'ckpt hook UserPromptSubmit: observation not recorded (ERR_RUN_LOCKED)\n',
        'ckpt hook Stop: observation not recorded (ERR_RUN_LOCKED)\n',
        'ckpt hook (unparsed): observation not recorded (ERR_RUN_LOCKED)\n',
      ]);
      expect(stderr.join('')).not.toContain('ghp_');
    });

    it('does not retry other errors', async () => {
      const engine = new FakeEngine();
      const sleep = vi.fn(async () => undefined);
      engine.failRecord = (draft) => (draft.type === 'model.requested' ? new StorageError('ERR_CORRUPT', 'broken ledger') : undefined);
      const handler = createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, sleep });
      await handler.handleHook(fixture(FIXTURES.UserPromptSubmit));
      expect(sleep).not.toHaveBeenCalled();
      expect(engine.types).toEqual(['run.created', 'adapter.error']);
    });
  });

  it('resolves even when record() rejects with a non-Error value, naming only its type on stderr', async () => {
    const engine = new FakeEngine();
    engine.failRecord = () => 'boom' as unknown as Error;
    const stderr: string[] = [];
    const handler = createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, stderr: (line) => stderr.push(line) });
    await expect(handler.handleHook(fixture(FIXTURES.UserPromptSubmit))).resolves.toBeNull();
    expect(stderr).toEqual(['ckpt hook UserPromptSubmit: observation not recorded (string)\n']);
  });

  it('a stderr sink that throws does not make handleHook reject', async () => {
    const engine = new FakeEngine();
    engine.failRecord = () => new Error('down');
    const handler = createHookHandler({
      engine,
      ledger: engine,
      env: { [RUN_ID_ENV]: RUN_ID },
      stderr: () => {
        throw new Error('EPIPE');
      },
    });
    await expect(handler.handleHook(fixture(FIXTURES.UserPromptSubmit))).resolves.toBeNull();
  });

  describe('unbound invocations (plain claude with hooks installed)', () => {
    it.each([
      ['no CKPT_RUN_ID', {}],
      ['an empty CKPT_RUN_ID', { [RUN_ID_ENV]: '  ' }],
    ])('with %s: resolves null, appends, checkpoints, reads and prints nothing', async (_label, env) => {
      const { engine, handler, status, stderr } = harness({ env });
      const recordSpy = vi.spyOn(engine, 'record');
      const getEvents = vi.spyOn(engine, 'getEvents');
      for (const name of [FIXTURES.SessionStart, FIXTURES.PreToolUse, FIXTURES.PostToolUse, FIXTURES.Stop, FIXTURES.SessionEnd]) {
        await expect(handler.handleHook(fixture(name))).resolves.toBeNull();
      }
      await expect(handler.handleHook('{not json')).resolves.toBeNull();
      expect(recordSpy).not.toHaveBeenCalled();
      expect(getEvents).not.toHaveBeenCalled();
      expect(engine.types).toEqual(['run.created']);
      expect(engine.checkpoints).toEqual([]);
      expect(status.calls).toEqual([]);
      expect(stderr).toEqual([]);
    });

    it('boundRunId tells a caller whether to open a store at all', () => {
      expect(boundRunId({})).toBeNull();
      expect(boundRunId({ [RUN_ID_ENV]: '' })).toBeNull();
      expect(boundRunId({ [RUN_ID_ENV]: ' \t' })).toBeNull();
      expect(boundRunId({ [RUN_ID_ENV]: ` ${RUN_ID} ` })).toBe(RUN_ID);
    });
  });
});
