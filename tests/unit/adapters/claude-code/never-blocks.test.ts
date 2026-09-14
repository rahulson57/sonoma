/**
 * SPEC-009 criterion: a malformed or unknown hook payload makes handleHook exit 0 and append adapter.error or
 * adapter.unknown_hook. More generally, handleHook never rejects: a failure while recording, reading git status or
 * checkpointing is recorded as adapter.error, and the `ckpt hook` process exits 0 on whatever it resolves to.
 * DEC-044: an unbound invocation writes and prints nothing; a lock that never frees costs at most MAX_LOCK_WAIT_MS
 * (≤ 5 s), and the lost observation is reported as one stderr line that carries no payload data.
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
    it('the default retry waits a fixed delay, capped by an exported constant of at most 5 s', () => {
      expect(MAX_LOCK_WAIT_MS).toBeLessThanOrEqual(5000);
      expect(DEFAULT_LOCK_RETRY.delayMs).toBe(LOCK_RETRY_DELAY_MS);
      expect((DEFAULT_LOCK_RETRY.attempts - 1) * DEFAULT_LOCK_RETRY.delayMs).toBeLessThanOrEqual(MAX_LOCK_WAIT_MS);
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

    it('with the default policy, a lock that never frees waits at most MAX_LOCK_WAIT_MS per write', async () => {
      const engine = new FakeEngine();
      engine.failRecord = () => new StorageError('ERR_RUN_LOCKED', 'held');
      let waited = 0;
      const stderr: string[] = [];
      const handler = createHookHandler({
        engine,
        ledger: engine,
        env: { [RUN_ID_ENV]: RUN_ID },
        sleep: async (ms) => {
          waited += ms;
        },
        stderr: (line) => stderr.push(line),
      });
      await expect(handler.handleHook(fixture(FIXTURES.UserPromptSubmit))).resolves.toBeNull();
      // The hook's own event, then the adapter.error attempt: two writes, each capped.
      expect(waited).toBeLessThanOrEqual(2 * MAX_LOCK_WAIT_MS);
      expect(stderr).toHaveLength(1);
    });

    it('when even adapter.error cannot be appended: resolves null, one stderr line with no payload data, nothing appended', async () => {
      const engine = new FakeEngine();
      engine.failRecord = () => new StorageError('ERR_RUN_LOCKED', 'held by another process');
      const stderr: string[] = [];
      const handler = createHookHandler({
        engine,
        ledger: engine,
        env: { [RUN_ID_ENV]: RUN_ID },
        lockRetry: { attempts: 3, delayMs: 0 },
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
