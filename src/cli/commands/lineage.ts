/** `ckpt resume`, `ckpt fork` and `ckpt rollback`: the Checkpoint Engine's lineage operations. */
import { formatCheckpointRef } from '../../engine/index.js';
import type { RefInvocation } from '../args.js';
import { EXIT_OK, type ExitCode } from '../errors.js';
import type { CliIo } from '../io.js';
import type { CliModules } from '../modules.js';
import { renderResumeSummary, renderRollbackWarning } from '../render.js';

/**
 * Engine resume(), then the Context Builder. The context is built from the stored state and never distilled (DEC-005,
 * DEC-006). The context goes to stdout so it can be handed to an agent; the summary goes to stderr.
 */
export async function resume(invocation: RefInvocation, modules: CliModules, io: CliIo): Promise<ExitCode> {
  const restored = await modules.engine.resume(invocation.ref);
  const context = await modules.context.buildResumeContext(restored);
  io.stderr(renderResumeSummary(formatCheckpointRef(invocation.ref), restored, context));
  io.stdout(context.systemPreamble.endsWith('\n') ? context.systemPreamble : `${context.systemPreamble}\n`);
  return EXIT_OK;
}

/** Prints the new run's id on stdout. */
export async function fork(invocation: RefInvocation, modules: CliModules, io: CliIo): Promise<ExitCode> {
  const run = await modules.engine.fork(invocation.ref);
  io.stderr(`Forked ${formatCheckpointRef(invocation.ref)} into a new run.\n`);
  io.stdout(`${run.run_id}\n`);
  return EXIT_OK;
}

/** Every side effect the rollback cannot undo is printed on stderr. The warnings never change the exit code (0). */
export async function rollback(invocation: RefInvocation, modules: CliModules, io: CliIo): Promise<ExitCode> {
  const result = await modules.engine.rollback(invocation.ref);
  for (const warning of result.warnings) io.stderr(renderRollbackWarning(warning));
  io.stdout(
    `Rolled back to ${formatCheckpointRef(invocation.ref)} (workspace ${result.restored.workspace_commit}); ${result.warnings.length} side effect warning(s).\n`,
  );
  return EXIT_OK;
}
