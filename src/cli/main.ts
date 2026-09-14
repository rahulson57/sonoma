/**
 * `ckpt` entry point (SPEC-013 `main(argv: string[]): Promise<ExitCode>`). It parses the arguments, dispatches to the
 * module that owns the command, and renders the result. Exit codes: 0 success, 1 runtime error, 2 usage error,
 * 3 user aborted.
 */
import { parseArgs, usageText, type Invocation } from './args.js';
import { exportBundle, importBundle } from './commands/bundle.js';
import { distill } from './commands/distill.js';
import { diff, list, reindex, show } from './commands/inspect.js';
import { fork, resume, rollback } from './commands/lineage.js';
import { hook, runClaude, ui } from './commands/session.js';
import { defaultDeps, withModules, type CliDeps } from './deps.js';
import { EXIT_OK, EXIT_RUNTIME_ERROR, EXIT_USAGE, UsageError, describeError, type ExitCode } from './errors.js';

function dispatch(invocation: Invocation, deps: CliDeps): Promise<ExitCode> {
  const { io } = deps;
  switch (invocation.command) {
    case 'help':
      io.stdout(usageText());
      return Promise.resolve(EXIT_OK);
    case 'run':
      return runClaude(invocation, deps);
    case 'list':
      return withModules(deps, (modules) => list(invocation, modules, io));
    case 'show':
      return withModules(deps, (modules) => show(invocation, modules, io));
    case 'diff':
      return withModules(deps, (modules) => diff(invocation, modules, io));
    case 'resume':
      return withModules(deps, (modules) => resume(invocation, modules, io));
    case 'fork':
      return withModules(deps, (modules) => fork(invocation, modules, io));
    case 'rollback':
      return withModules(deps, (modules) => rollback(invocation, modules, io));
    case 'export':
      return withModules(deps, (modules) => exportBundle(invocation, modules, io));
    case 'import':
      return withModules(deps, (modules) => importBundle(invocation, modules, io));
    case 'distill':
      return distill(invocation, deps);
    case 'reindex':
      return withModules(deps, (modules) => reindex(modules, io));
    case 'ui':
      return ui(invocation, deps);
    case 'hook':
      return hook(invocation, deps);
  }
}

/** Never rejects: every failure becomes an exit code and a message on stderr. */
export async function main(argv: readonly string[], overrides: Partial<CliDeps> = {}): Promise<ExitCode> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  let invocation: Invocation;
  try {
    invocation = parseArgs(argv);
  } catch (err) {
    deps.io.stderr(`ckpt: ${err instanceof UsageError ? err.message : describeError(err)}\n\n${usageText()}`);
    return EXIT_USAGE;
  }
  try {
    return await dispatch(invocation, deps);
  } catch (err) {
    deps.io.stderr(`ckpt ${invocation.command}: ${describeError(err)}\n`);
    return EXIT_RUNTIME_ERROR;
  }
}
