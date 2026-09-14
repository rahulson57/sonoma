/**
 * run(args): `ckpt run claude [...claudeArgs]` — run an unmodified Claude Code session under observation.
 *
 * 1. installHooks(projectDir), so Claude Code invokes `ckpt hook <event>` for every mapped hook.
 * 2. Start the run through the Checkpoint Engine (startRun emits run.created), then CLOSE the store. Storage takes a
 *    run's writer lock per process and holds it until close, and the hook processes Claude Code spawns must write.
 * 3. Spawn `claude` with the caller's arguments, inheriting stdio, with CKPT_RUN_ID naming the run. Claude Code passes
 *    its environment to hook commands, which is how each hook invocation finds its run without an adapter store.
 * 4. While claude runs, ckpt owns its lifecycle. A terminal delivers Ctrl-C (SIGINT) and Ctrl-\ (SIGQUIT) to the whole
 *    foreground process group, so claude already receives them and decides what they mean (Ctrl-C interrupts a turn);
 *    ckpt ignores them rather than die and orphan claude. SIGTERM and SIGHUP aimed at ckpt are forwarded to claude,
 *    whose exit then ends the run. The listeners are removed once claude exits or fails to start.
 * 5. Resolve to claude's exit code: the code it exited with, 128 + signal number when killed by a signal, 127 when the
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

/** Where process signals are observed. Default `process`. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** Signals the terminal sends to the whole foreground process group: claude receives them itself; ckpt ignores them. */
export const IGNORED_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGINT', 'SIGQUIT']);

/** Signals aimed at ckpt (kill, a closed terminal): forwarded to claude. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGTERM', 'SIGHUP']);

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
  readonly signals?: SignalSource;
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
  const signals: SignalSource = options.signals ?? process;

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
        let child: ChildProcess | undefined;
        const ignore = (): void => {};
        const forwarders = FORWARDED_SIGNALS.map((signal) => {
          const forward = (): void => {
            try {
              child?.kill(signal);
            } catch {
              // claude is already gone; its exit event settles the run
            }
          };
          return [signal, forward] as const;
        });
        for (const signal of IGNORED_SIGNALS) signals.on(signal, ignore);
        for (const [signal, forward] of forwarders) signals.on(signal, forward);

        let settled = false;
        const settle = (code: ExitCode): void => {
          if (settled) return;
          settled = true;
          for (const signal of IGNORED_SIGNALS) signals.off(signal, ignore);
          for (const [signal, forward] of forwarders) signals.off(signal, forward);
          resolve(code);
        };
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
