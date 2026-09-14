/**
 * run(args) (`ckpt run claude [...claudeArgs]`): installs hooks, starts the run through the engine, CLOSES the store
 * before spawning (hook processes need the run's writer lock), passes CKPT_RUN_ID to claude, and resolves to claude's
 * exit code. No real claude is spawned.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_AGENT, EXIT_COMMAND_NOT_FOUND, RUN_ID_ENV, createRunner, type RunnerOptions } from '../../../../src/adapters/claude-code/index.js';
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
});
