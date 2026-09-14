/** `ckpt run claude`, `ckpt ui` and the adapter's internal `ckpt hook <event>`. */
import { boundRunId } from '../../adapters/claude-code/index.js';
import type { InvocationOf } from '../args.js';
import { withModules, type CliDeps } from '../deps.js';
import { EXIT_OK, errorKind, type ExitCode } from '../errors.js';

/** Claude Code Adapter run(): resolves to claude's own exit code. */
export function runClaude(invocation: InvocationOf<'run'>, deps: CliDeps): Promise<ExitCode> {
  return deps.createRunner(deps.io).run(invocation.args);
}

/** Serves the read-only inspector until shutdown (Ctrl-C), then stops it and closes the store. */
export function ui(invocation: InvocationOf<'ui'>, deps: CliDeps): Promise<ExitCode> {
  return withModules(deps, async (modules) => {
    const handle = await modules.inspector.start({ port: invocation.port });
    try {
      deps.io.stdout(`ckpt inspector (read-only) listening on ${handle.url}\nPress Ctrl-C to stop.\n`);
      await deps.untilShutdown();
    } finally {
      await handle.close();
    }
    return EXIT_OK;
  });
}

/**
 * `ckpt hook <event>`: what the hooks installed by the Claude Code Adapter run (SPEC-009 installHooks). The payload
 * arrives on stdin and goes to the adapter's handleHook unparsed.
 *
 * A hook must never block or fail the agent's tool call, so this always exits 0. The adapter records its own failures as
 * adapter.error. A failure before it can run, such as a store that cannot be opened, becomes one stderr line naming the
 * error kind only. The error message could echo payload bytes, so it is never printed.
 */
export async function hook(invocation: InvocationOf<'hook'>, deps: CliDeps): Promise<ExitCode> {
  // Plain `claude` with hooks installed but outside `ckpt run claude`: nothing to record, and no store is opened.
  if (boundRunId(deps.io.env) === null) return EXIT_OK;
  try {
    const payload = await deps.io.readStdin();
    await withModules(deps, (modules) => modules.hooks.handleHook(payload));
  } catch (err) {
    deps.io.stderr(`ckpt hook ${invocation.event}: observation not recorded (${errorKind(err)})\n`);
  }
  return EXIT_OK;
}
