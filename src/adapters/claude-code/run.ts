/**
 * run(args): `ckpt run claude [...claudeArgs]` — run an unmodified Claude Code session under observation.
 *
 * 1. installHooks(projectDir), so Claude Code invokes `ckpt hook <event>` for every mapped hook.
 * 2. Start the run through the Checkpoint Engine (startRun emits run.created), then CLOSE the store. Storage takes a
 *    run's writer lock per process and holds it until close, and the hook processes Claude Code spawns must write.
 * 3. Spawn `claude` with the caller's arguments, inheriting stdio, with CKPT_RUN_ID naming the run. Claude Code passes
 *    its environment to hook commands, which is how each hook invocation finds its run without an adapter store.
 * 4. Resolve to claude's exit code: the code it exited with, 128 + signal number when killed by a signal, 127 when the
 *    executable cannot be found. Checkpoints happen in the Stop and SessionEnd hooks, not here.
 *
 * The CLI (a later slice) owns argument parsing and opening the engine; this module takes both as inputs.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
import type { CheckpointEngine } from '../../engine/index.js';
import { installHooks as installProjectHooks } from './install.js';
import { CLAUDE_CODE_AGENT, RUN_ID_ENV, type ExitCode } from './types.js';

export interface OpenedEngine {
  readonly engine: Pick<CheckpointEngine, 'startRun'>;
  /** Closes the store (releasing its run locks). */
  close(): Promise<void>;
}

export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface RunnerOptions {
  /** The project Claude Code runs in (its working directory, and where hooks are installed). */
  readonly projectDir: string;
  readonly openEngine: () => Promise<OpenedEngine>;
  /** Default `claude`. */
  readonly command?: string;
  /** Base environment for claude. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnProcess;
  readonly installHooks?: (projectDir: string) => Promise<void>;
}

export interface Runner {
  run(args: string[]): Promise<ExitCode>;
}

export const EXIT_COMMAND_NOT_FOUND = 127;

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): ExitCode {
  if (code !== null) return code;
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return 1;
}

export function createRunner(options: RunnerOptions): Runner {
  const command = options.command ?? 'claude';
  const spawn = options.spawn ?? nodeSpawn;
  const install = options.installHooks ?? installProjectHooks;

  return {
    async run(args: string[]): Promise<ExitCode> {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('run needs an array of string arguments');
      await install(options.projectDir);

      const opened = await options.openEngine();
      let runId: string;
      try {
        runId = (await opened.engine.startRun({ agent: CLAUDE_CODE_AGENT })).run_id;
      } finally {
        await opened.close();
      }

      const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), [RUN_ID_ENV]: runId };
      return new Promise<ExitCode>((resolve) => {
        let settled = false;
        const settle = (code: ExitCode): void => {
          if (!settled) {
            settled = true;
            resolve(code);
          }
        };
        let child: ChildProcess;
        try {
          child = spawn(command, args, { cwd: options.projectDir, env, stdio: 'inherit' });
        } catch {
          settle(EXIT_COMMAND_NOT_FOUND);
          return;
        }
        child.once('error', (err: NodeJS.ErrnoException) => settle(err.code === 'ENOENT' ? EXIT_COMMAND_NOT_FOUND : 1));
        child.once('exit', (code, signal) => settle(exitCodeOf(code, signal)));
      });
    },
  };
}
