/** `ckpt list`, `ckpt show`, `ckpt diff` and `ckpt reindex`: Storage and Engine reads, plus index maintenance. */
import { formatCheckpointRef } from '../../engine/index.js';
import type { InvocationOf } from '../args.js';
import { EXIT_OK, type ExitCode } from '../errors.js';
import type { CliIo } from '../io.js';
import type { CliModules } from '../modules.js';
import { json, renderCheckpoints, renderDiff, renderPanes, renderReindex, renderRuns } from '../render.js';

/** Runs, or the checkpoints of one run with their parent lineage. */
export async function list(invocation: InvocationOf<'list'>, modules: CliModules, io: CliIo): Promise<ExitCode> {
  if (invocation.runId === null) {
    const runs = await modules.storage.listRuns();
    io.stdout(invocation.json ? json(runs) : renderRuns(runs));
  } else {
    const checkpoints = await modules.storage.listCheckpoints(invocation.runId);
    io.stdout(invocation.json ? json(checkpoints) : renderCheckpoints(invocation.runId, checkpoints));
  }
  return EXIT_OK;
}

export async function show(invocation: InvocationOf<'show'>, modules: CliModules, io: CliIo): Promise<ExitCode> {
  const id = formatCheckpointRef(invocation.ref);
  const panes = await modules.inspector.checkpoint(id);
  io.stdout(invocation.json ? json(panes) : renderPanes(id, panes));
  return EXIT_OK;
}

export async function diff(invocation: InvocationOf<'diff'>, modules: CliModules, io: CliIo): Promise<ExitCode> {
  const result = await modules.engine.diff(invocation.a, invocation.b);
  io.stdout(invocation.json ? json(result) : renderDiff(formatCheckpointRef(invocation.a), formatCheckpointRef(invocation.b), result));
  return EXIT_OK;
}

export async function reindex(modules: CliModules, io: CliIo): Promise<ExitCode> {
  io.stdout(renderReindex(await modules.storage.reindex()));
  return EXIT_OK;
}
