/**
 * Argument parsing for `ckpt <command> [args] [flags]` (SPEC-013 "Commands"). Pure: no I/O and no module calls.
 * Anything malformed throws UsageError, which main() turns into exit 2 with the usage text on stderr. The one exception
 * is the adapter-internal `ckpt hook`, which never fails parsing (DEC-066).
 */
import type { ExportTarget } from '../bundle/index.js';
import { parseCheckpointRef, type CheckpointRef } from '../engine/index.js';
import { RUN_ID_PATTERN } from '../storage/index.js';
import { DEFAULT_PORT } from '../ui/index.js';
import { UsageError } from './errors.js';

/** Commands that take exactly one checkpoint id. */
export type RefCommand = 'resume' | 'fork' | 'rollback' | 'distill';

export interface RefInvocation {
  readonly command: RefCommand;
  readonly ref: CheckpointRef;
}

export type Invocation =
  | { readonly command: 'help' }
  | { readonly command: 'run'; readonly agent: 'claude'; readonly args: string[] }
  | { readonly command: 'list'; readonly runId: string | null; readonly json: boolean }
  | { readonly command: 'show'; readonly ref: CheckpointRef; readonly json: boolean }
  | { readonly command: 'diff'; readonly a: CheckpointRef; readonly b: CheckpointRef; readonly json: boolean }
  | RefInvocation
  | { readonly command: 'export'; readonly target: ExportTarget; readonly unsafe: boolean }
  | { readonly command: 'import'; readonly bundlePath: string }
  | { readonly command: 'reindex' }
  | { readonly command: 'ui'; readonly port: number }
  | { readonly command: 'hook'; readonly event: string };

/** The invocation of one single-valued command, e.g. `InvocationOf<'export'>`. */
export type InvocationOf<C extends Exclude<Invocation['command'], RefCommand>> = Extract<Invocation, { readonly command: C }>;

type Flag = 'json' | 'unsafe' | 'port';

interface CommandSpec {
  readonly usage: string;
  readonly summary: string;
  /** Inclusive bounds on positional arguments. */
  readonly positionals: readonly [number, number];
  readonly flags: readonly Flag[];
}

/** The 12 user-facing commands, in SPEC-013 table order. */
export const COMMANDS = {
  run: { usage: 'ckpt run claude [args...]', summary: 'install hooks, then run Claude Code under observation', positionals: [1, Infinity], flags: [] },
  list: { usage: 'ckpt list [runId] [--json]', summary: 'list runs, or the checkpoints of one run with parent lineage', positionals: [0, 1], flags: ['json'] },
  show: { usage: 'ckpt show <checkpointId> [--json]', summary: 'STATE, WORKSPACE and LEDGER panes of a checkpoint', positionals: [1, 1], flags: ['json'] },
  diff: { usage: 'ckpt diff <a> <b> [--json]', summary: 'state, workspace, ledger and side-effect diff', positionals: [2, 2], flags: ['json'] },
  resume: { usage: 'ckpt resume <checkpointId>', summary: 'restore a checkpoint and print a fresh resume context', positionals: [1, 1], flags: [] },
  fork: { usage: 'ckpt fork <checkpointId>', summary: 'start a new run from a checkpoint; prints the new run id', positionals: [1, 1], flags: [] },
  rollback: { usage: 'ckpt rollback <checkpointId>', summary: 'restore a checkpoint; warns about every side effect it cannot undo', positionals: [1, 1], flags: [] },
  export: { usage: 'ckpt export <runId|checkpointId> [--unsafe]', summary: 'scan and report, then write a bundle only after confirmation', positionals: [1, 1], flags: ['unsafe'] },
  import: { usage: 'ckpt import <bundle>', summary: 'verify and import a bundle', positionals: [1, 1], flags: [] },
  distill: { usage: 'ckpt distill <checkpointId>', summary: 'distill a semantic projection (the only command that calls an LLM)', positionals: [1, 1], flags: [] },
  reindex: { usage: 'ckpt reindex', summary: 'rebuild the metadata index from the ledger, CAS and refs', positionals: [0, 0], flags: [] },
  ui: { usage: `ckpt ui [--port ${DEFAULT_PORT}]`, summary: 'serve the read-only inspector on localhost', positionals: [0, 0], flags: ['port'] },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

export function usageText(): string {
  const specs: readonly CommandSpec[] = Object.values(COMMANDS);
  const width = Math.max(...specs.map((spec) => spec.usage.length));
  return [
    'Usage: ckpt <command> [args] [flags]',
    '',
    'Commands:',
    ...specs.map((spec) => `  ${spec.usage.padEnd(width)}  ${spec.summary}`),
    '',
    'A checkpoint id is run_<ulid>:c_<n>.',
    'Exit codes: 0 success, 1 runtime error, 2 usage error, 3 aborted.',
    '',
  ].join('\n');
}

interface Tokens {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<Flag, string | true>;
}

function readFlag(command: string, spec: CommandSpec, token: string, next: string | undefined): { flag: Flag; value: string | true; consumed: number } {
  const eq = token.indexOf('=');
  const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
  const flag = spec.flags.find((candidate) => candidate === name);
  if (!token.startsWith('--') || flag === undefined) throw new UsageError(`ckpt ${command}: unknown flag ${token}`);
  if (flag !== 'port') {
    if (eq >= 0) throw new UsageError(`ckpt ${command}: --${flag} takes no value`);
    return { flag, value: true, consumed: 0 };
  }
  if (eq >= 0) return { flag, value: token.slice(eq + 1), consumed: 0 };
  if (next === undefined) throw new UsageError(`ckpt ${command}: --${flag} needs a value`);
  return { flag, value: next, consumed: 1 };
}

function splitTokens(command: string, spec: CommandSpec, tokens: readonly string[]): Tokens {
  const positionals: string[] = [];
  const flags = new Map<Flag, string | true>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    const { flag, value, consumed } = readFlag(command, spec, token, tokens[i + 1]);
    if (flags.has(flag)) throw new UsageError(`ckpt ${command}: --${flag} given more than once`);
    flags.set(flag, value);
    i += consumed;
  }
  const [min, max] = spec.positionals;
  if (positionals.length < min) throw new UsageError(`ckpt ${command}: missing argument (${spec.usage})`);
  if (positionals.length > max) throw new UsageError(`ckpt ${command}: unexpected argument ${JSON.stringify(positionals[max])} (${spec.usage})`);
  return { positionals, flags };
}

function checkpointRef(command: string, text: string): CheckpointRef {
  try {
    return parseCheckpointRef(text);
  } catch {
    throw new UsageError(`ckpt ${command}: ${JSON.stringify(text)} is not a checkpoint id (run_<ulid>:c_<n>)`);
  }
}

function runId(command: string, text: string): string {
  if (!RUN_ID_PATTERN.test(text)) throw new UsageError(`ckpt ${command}: ${JSON.stringify(text)} is not a run id (run_<ulid>)`);
  return text;
}

/** SPEC-011 ExportTarget: a whole run (`run_<ulid>`) or one checkpoint (`run_<ulid>:c_<n>`). */
function exportTarget(text: string): ExportTarget {
  if (RUN_ID_PATTERN.test(text)) return text;
  const ref = checkpointRef('export', text);
  return { run_id: ref.runId, checkpoint_id: ref.checkpointId };
}

function port(value: string | true | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const n = typeof value === 'string' && /^[0-9]{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(n >= 0 && n <= 65_535)) throw new UsageError(`ckpt ui: --port must be an integer in 0..65535, got ${JSON.stringify(value)}`);
  return n;
}

function build(command: Exclude<CommandName, 'run'>, tokens: Tokens): Invocation {
  const [first = '', second = ''] = tokens.positionals;
  const json = tokens.flags.has('json');
  switch (command) {
    case 'list':
      return { command, runId: tokens.positionals.length === 0 ? null : runId(command, first), json };
    case 'show':
      return { command, ref: checkpointRef(command, first), json };
    case 'diff':
      return { command, a: checkpointRef(command, first), b: checkpointRef(command, second), json };
    case 'resume':
    case 'fork':
    case 'rollback':
    case 'distill':
      return { command, ref: checkpointRef(command, first) };
    case 'export':
      return { command, target: exportTarget(first), unsafe: tokens.flags.has('unsafe') };
    case 'import':
      return { command, bundlePath: first };
    case 'reindex':
      return { command };
    case 'ui':
      return { command, port: port(tokens.flags.get('port')) };
  }
}

/** `ckpt run claude [args...]`: everything after `claude` belongs to Claude Code, flags included. */
function parseRun(rest: readonly string[]): Invocation {
  const agent = rest[0];
  if (agent === undefined) throw new UsageError(`ckpt run: missing argument (${COMMANDS.run.usage})`);
  if (agent !== 'claude') throw new UsageError(`ckpt run: the only v1 agent is claude, got ${JSON.stringify(agent)}`);
  return { command: 'run', agent, args: rest.slice(1) };
}

/** Parses `argv` (without the node and script paths). */
export function parseArgs(argv: readonly string[]): Invocation {
  const [command, ...rest] = argv;
  if (command === undefined || command === '') throw new UsageError('missing command');
  if (command === 'help' || command === '--help' || command === '-h') return { command: 'help' };
  if (command === 'run') return parseRun(rest);
  // `ckpt hook <event>` is run by the hooks the Claude Code Adapter installs (SPEC-009), not by users, so it is not in
  // the usage text. It never fails parsing (DEC-066): Claude Code reads a hook's exit 2 as "block the tool call". So a
  // missing or unknown event, extra arguments and flags all pass through, and the adapter records what it cannot use.
  if (command === 'hook') return { command: 'hook', event: rest[0] ?? '' };
  if (!Object.hasOwn(COMMANDS, command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  const name = command as Exclude<CommandName, 'run'>;
  return build(name, splitTokens(name, COMMANDS[name], rest));
}
