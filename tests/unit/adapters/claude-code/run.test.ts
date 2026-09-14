/**
 * run(args) (`ckpt run claude [...claudeArgs]`): installs hooks, starts the run through the engine, CLOSES the store
 * before spawning (hook processes need the run's writer lock), passes CKPT_RUN_ID to claude, and resolves to claude's
 * exit code. While claude runs, a terminal Ctrl-C (SIGINT) or Ctrl-\ (SIGQUIT) must not kill ckpt and orphan claude,
 * and SIGTERM/SIGHUP are forwarded to claude. No real claude is spawned.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_AGENT,
  EXIT_COMMAND_NOT_FOUND,
  FORWARDED_SIGNALS,
  IGNORED_SIGNALS,
  RUN_ID_ENV,
  createRunner,
  type RunnerOptions,
} from '../../../../src/adapters/claude-code/index.js';
import type { Run } from '../../../../src/model/types.js';
import { RUN_ID } from './support.js';

type Outcome = { exit: [number | null, NodeJS.Signals | null] } | { error: NodeJS.ErrnoException } | { throws: Error };

function scenario(outcome: Outcome = { exit: [0, null] }, overrides: Partial<RunnerOptions> = {}) {
  const log: string[] = [];
  const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const options: RunnerOptions = {
    projectDir: '/work/app',
    env: { PATH: '/usr/bin', HOME: '/home/dev' },
    installHooks: async (dir) => {
      log.push(`install ${dir}`);
    },
    openEngine: async () => {
      log.push('open');
      return {
        engine: {
          startRun: async (input: { readonly agent: string }) => {
            log.push(`startRun ${input.agent}`);
            return { run_id: RUN_ID, agent: input.agent, parent_run_id: null, forked_from_checkpoint: null, created_at: '' } as Run;
          },
        },
        close: async () => {
          log.push('close');
        },
      };
    },
    spawn: (command, args, spawnOptions) => {
      log.push(`spawn ${command}`);
      spawned.push({ command, args, options: spawnOptions });
      if ('throws' in outcome) throw outcome.throws;
      const child = new EventEmitter();
      setImmediate(() => {
        if ('error' in outcome) child.emit('error', outcome.error);
        else child.emit('exit', ...outcome.exit);
      });
      return child as unknown as ChildProcess;
    },
    ...overrides,
  };
  return { runner: createRunner(options), log, spawned };
}

const HANDLED_SIGNALS = [...IGNORED_SIGNALS, ...FORWARDED_SIGNALS];

function listenerCounts(source: { listenerCount(event: string): number }): number[] {
  return HANDLED_SIGNALS.map((signal) => source.listenerCount(signal));
}

/** A claude child that exits only when told to, recording every kill() it receives. */
function heldChild() {
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const emitter = Object.assign(new EventEmitter(), {
    kill: (signal?: NodeJS.Signals | number) => {
      kills.push(signal);
      return true;
    },
  });
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const spawn = () => {
    markSpawned();
    return emitter as unknown as ChildProcess;
  };
  return { emitter, kills, spawned, spawn };
}

describe('run (ckpt run claude)', () => {
  it('installs hooks, starts the run, closes the store, then spawns claude with the args and CKPT_RUN_ID', async () => {
    const { runner, log, spawned } = scenario();
    await expect(runner.run(['--model', 'opus', 'fix the tests'])).resolves.toBe(0);
    expect(log).toEqual(['install /work/app', 'open', `startRun ${CLAUDE_CODE_AGENT}`, 'close', 'spawn claude']);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(['--model', 'opus', 'fix the tests']);
    expect(spawned[0]!.options).toMatchObject({ cwd: '/work/app', stdio: 'inherit' });
    expect(spawned[0]!.options.env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev', [RUN_ID_ENV]: RUN_ID });
  });

  it.each([
    ['exit code 3', { exit: [3, null] } as Outcome, 3],
    ['SIGTERM', { exit: [null, 'SIGTERM'] } as Outcome, 128 + constants.signals.SIGTERM],
    ['SIGINT', { exit: [null, 'SIGINT'] } as Outcome, 128 + constants.signals.SIGINT],
    ['a missing claude executable', { error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) } as Outcome, EXIT_COMMAND_NOT_FOUND],
    ['spawn throwing', { throws: new Error('EINVAL') } as Outcome, EXIT_COMMAND_NOT_FOUND],
  ])('resolves to claude’s exit status on %s', async (_label, outcome, code) => {
    const { runner } = scenario(outcome);
    await expect(runner.run([])).resolves.toBe(code);
  });

  it('uses a custom command', async () => {
    const { runner, spawned } = scenario(undefined, { command: '/opt/claude/bin/claude' });
    await runner.run([]);
    expect(spawned[0]!.command).toBe('/opt/claude/bin/claude');
  });

  it('closes the store and spawns nothing when startRun fails', async () => {
    const log: string[] = [];
    const { runner, spawned } = scenario(undefined, {
      openEngine: async () => ({
        engine: {
          startRun: async () => {
            throw new Error('ERR_INVALID_INPUT');
          },
        },
        close: async () => {
          log.push('close');
        },
      }),
    });
    await expect(runner.run([])).rejects.toThrow('ERR_INVALID_INPUT');
    expect(log).toEqual(['close']);
    expect(spawned).toEqual([]);
  });

  it('rejects arguments that are not strings before doing anything', async () => {
    const { runner, log } = scenario();
    await expect(runner.run([1 as unknown as string])).rejects.toBeInstanceOf(TypeError);
    expect(log).toEqual([]);
  });

  describe('signals while claude runs', () => {
    it('SIGINT/SIGQUIT are ignored and SIGTERM/SIGHUP forwarded via child.kill; the listeners exist only while claude runs', async () => {
      const signals = new EventEmitter();
      const child = heldChild();
      const { runner } = scenario(undefined, { signals, spawn: child.spawn });
      expect(listenerCounts(signals)).toEqual([0, 0, 0, 0]);

      let resolved = false;
      const running = runner.run([]).finally(() => {
        resolved = true;
      });
      await child.spawned;
      expect(listenerCounts(signals)).toEqual([1, 1, 1, 1]);

      // A terminal Ctrl-C / Ctrl-\ reaches claude directly; ckpt survives it and keeps waiting.
      signals.emit('SIGINT');
      signals.emit('SIGQUIT');
      await new Promise((resolve) => setImmediate(resolve));
      expect(child.kills).toEqual([]);
      expect(resolved).toBe(false);

      signals.emit('SIGTERM');
      expect(child.kills).toEqual(['SIGTERM']);
      signals.emit('SIGHUP');
      expect(child.kills).toEqual(['SIGTERM', 'SIGHUP']);
      expect(listenerCounts(signals)).toEqual([1, 1, 1, 1]);

      child.emitter.emit('exit', null, 'SIGTERM');
      await expect(running).resolves.toBe(128 + constants.signals.SIGTERM);
      expect(listenerCounts(signals)).toEqual([0, 0, 0, 0]);
    });

    it('after a Ctrl-C, run resolves to the exit code claude finishes with', async () => {
      const signals = new EventEmitter();
      const child = heldChild();
      const { runner } = scenario(undefined, { signals, spawn: child.spawn });
      const running = runner.run([]);
      await child.spawned;
      signals.emit('SIGINT');
      child.emitter.emit('exit', 0, null);
      await expect(running).resolves.toBe(0);
      expect(child.kills).toEqual([]);
      expect(listenerCounts(signals)).toEqual([0, 0, 0, 0]);
    });

    it.each([
      ['a missing claude executable', { error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) } as Outcome],
      ['spawn throwing', { throws: new Error('EINVAL') } as Outcome],
    ])('the listeners are removed when claude cannot be started (%s)', async (_label, outcome) => {
      const signals = new EventEmitter();
      const { runner } = scenario(outcome, { signals });
      await expect(runner.run([])).resolves.toBe(EXIT_COMMAND_NOT_FOUND);
      expect(listenerCounts(signals)).toEqual([0, 0, 0, 0]);
    });

    it('by default the listeners are installed on the real process, and removed from it', async () => {
      const before = listenerCounts(process);
      let during: number[] = [];
      const { runner } = scenario(undefined, {
        spawn: () => {
          during = listenerCounts(process);
          const child = new EventEmitter();
          setImmediate(() => child.emit('exit', 0, null));
          return child as unknown as ChildProcess;
        },
      });
      await expect(runner.run([])).resolves.toBe(0);
      expect(during).toEqual(before.map((count) => count + 1));
      expect(listenerCounts(process)).toEqual(before);
    });
  });
});
