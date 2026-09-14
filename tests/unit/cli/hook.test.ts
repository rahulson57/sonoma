/**
 * DEC-066: `ckpt hook <event>`, the entry point the hooks installed by the Claude Code Adapter run (SPEC-009).
 * - Unbound (no CKPT_RUN_ID): exit 0, and the store is never opened.
 * - Bound: stdin goes to handleHook exactly once, the store is closed, exit 0, nothing on stdout.
 * - It ALWAYS exits 0 and NEVER 2, because Claude Code reads a hook's exit 2 as "block the tool call". That includes a
 *   missing or unknown event argument, extra arguments, malformed stdin, unreadable stdin, a store-open failure and a
 *   handler throw.
 * - Nothing goes to stdout (Claude Code adds some hooks' stdout to the model's context). At most one stderr line, naming
 *   the error kind only.
 */
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/index.js';
import { RUN_ID, captureIo, fakeDeps } from './support.js';

const BOUND = { CKPT_RUN_ID: RUN_ID };
const PAYLOAD = JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-fixture' });

describe('ckpt hook (DEC-066)', () => {
  it('unbound: exits 0 without opening the store', async () => {
    const fx = fakeDeps(captureIo({ env: {}, stdin: PAYLOAD }));
    expect(await main(['hook', 'Stop'], fx.deps)).toBe(0);
    expect(fx.deps.openModules).not.toHaveBeenCalled();
    expect(fx.modules.hooks.handleHook).not.toHaveBeenCalled();
    expect(fx.io.out).toBe('');
    expect(fx.io.err).toBe('');
  });

  it('bound: hands the stdin payload to handleHook exactly once, closes the store, exits 0 and writes nothing to stdout', async () => {
    const fx = fakeDeps(captureIo({ env: BOUND, stdin: PAYLOAD }));
    expect(await main(['hook', 'Stop'], fx.deps)).toBe(0);
    expect(fx.deps.openModules).toHaveBeenCalledTimes(1);
    expect(fx.modules.hooks.handleHook).toHaveBeenCalledTimes(1);
    expect(fx.modules.hooks.handleHook).toHaveBeenCalledWith(PAYLOAD);
    expect(fx.modules.close).toHaveBeenCalledTimes(1);
    expect(fx.io.out).toBe('');
    expect(fx.io.err).toBe('');
  });

  it('a store-open failure exits 0, with one stderr line naming the error kind but not its message', async () => {
    const fx = fakeDeps(captureIo({ env: BOUND, stdin: PAYLOAD }));
    fx.deps.openModules.mockRejectedValueOnce(Object.assign(new Error('run is locked; payload bytes could be quoted here'), { code: 'ERR_RUN_LOCKED' }));

    expect(await main(['hook', 'PreToolUse'], fx.deps)).toBe(0);

    expect(fx.modules.hooks.handleHook).not.toHaveBeenCalled();
    expect(fx.io.out).toBe('');
    expect(fx.io.err).toBe('ckpt hook PreToolUse: observation not recorded (ERR_RUN_LOCKED)\n');
  });

  it('a handler throw exits 0 and the store is still closed', async () => {
    const fx = fakeDeps(captureIo({ env: BOUND, stdin: PAYLOAD }));
    fx.modules.hooks.handleHook.mockRejectedValueOnce(new TypeError('handler exploded'));

    expect(await main(['hook', 'Stop'], fx.deps)).toBe(0);

    expect(fx.modules.hooks.handleHook).toHaveBeenCalledTimes(1);
    expect(fx.modules.close).toHaveBeenCalledTimes(1);
    expect(fx.io.out).toBe('');
    expect(fx.io.err).toBe('ckpt hook Stop: observation not recorded (TypeError)\n');
  });

  it.each([
    ['bound', BOUND],
    ['unbound', {}],
  ])('a missing event argument exits 0, not 2 (%s)', async (_name, env) => {
    const fx = fakeDeps(captureIo({ env, stdin: PAYLOAD }));
    expect(await main(['hook'], fx.deps)).toBe(0);
    expect(fx.io.out).toBe('');
    expect(fx.io.err).not.toContain('Usage');
    expect(fx.modules.hooks.handleHook).toHaveBeenCalledTimes(env === BOUND ? 1 : 0);
  });

  it.each([
    ['an unknown event', ['hook', 'NotARealHook']],
    ['extra arguments', ['hook', 'Stop', 'extra', 'args']],
    ['flags', ['hook', '--json', 'Stop']],
  ])('%s still exits 0 and reaches the adapter', async (_name, argv) => {
    const fx = fakeDeps(captureIo({ env: BOUND, stdin: PAYLOAD }));
    expect(await main(argv, fx.deps)).toBe(0);
    expect(fx.modules.hooks.handleHook).toHaveBeenCalledTimes(1);
    expect(fx.io.out).toBe('');
  });

  it('malformed stdin goes to handleHook unchanged, so the adapter records adapter.error itself', async () => {
    const fx = fakeDeps(captureIo({ env: BOUND, stdin: '{not json' }));
    expect(await main(['hook', 'PostToolUse'], fx.deps)).toBe(0);
    expect(fx.modules.hooks.handleHook).toHaveBeenCalledWith('{not json');
  });

  it('unreadable stdin exits 0 without opening the store', async () => {
    const io = captureIo({ env: BOUND });
    io.readStdin = async () => {
      throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
    };
    const fx = fakeDeps(io);
    expect(await main(['hook', 'Stop'], fx.deps)).toBe(0);
    expect(fx.deps.openModules).not.toHaveBeenCalled();
    expect(fx.io.out).toBe('');
    expect(fx.io.err).toBe('ckpt hook Stop: observation not recorded (EPIPE)\n');
  });

  it('never builds the Distiller provider', async () => {
    const fx = fakeDeps(captureIo({ env: BOUND, stdin: PAYLOAD }));
    await main(['hook', 'Stop'], fx.deps);
    expect(fx.deps.createProvider).not.toHaveBeenCalled();
    expect(fx.provider.complete).not.toHaveBeenCalled();
  });
});
