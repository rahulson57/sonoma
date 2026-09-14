/** `ckpt distill <checkpointId>`: the only CLI path that may call an LLM (SPEC-013, DEC-006). */
import { DEFAULT_BUDGET_USD, distillRequestFor, type DistillBudget } from '../../distill/index.js';
import { formatCheckpointRef } from '../../engine/index.js';
import type { RefInvocation } from '../args.js';
import { withModules, type CliDeps } from '../deps.js';
import { CliError, EXIT_OK, type ExitCode } from '../errors.js';
import type { CliStorage } from '../modules.js';
import { renderDistill } from '../render.js';

/**
 * The run's distillation budget before this call. SPEC-007 has the caller persist DistillResult.budget but names no
 * budget store. So the spend is read back from what is durable: the usage on every distilled projection of the run's
 * checkpoints. The cap is SPEC-007's default, because no `distill.budgetUsd` configuration exists yet.
 */
export async function runBudget(storage: Pick<CliStorage, 'listCheckpoints' | 'listProjections'>, runId: string): Promise<DistillBudget> {
  let spentUsd = 0;
  for (const checkpoint of await storage.listCheckpoints(runId)) {
    for (const projection of await storage.listProjections({ runId, checkpointId: checkpoint.checkpoint_id })) {
      if (projection.source === 'distilled' && projection.usage !== null) spentUsd += projection.usage.costUsd;
    }
  }
  return { runId, capUsd: DEFAULT_BUDGET_USD, spentUsd };
}

export async function distill(invocation: RefInvocation, deps: CliDeps): Promise<ExitCode> {
  // The provider is built here and nowhere else. A missing credential fails before the store is opened.
  const provider = await deps.createProvider(deps.io);
  return withModules(deps, async (modules) => {
    const { runId, checkpointId } = invocation.ref;
    const checkpoint = await modules.storage.getCheckpoint({ run_id: runId, checkpoint_id: checkpointId });
    const parentId = checkpoint.parent_checkpoint_id;
    const parent = parentId === null ? null : await modules.storage.getCheckpoint({ run_id: runId, checkpoint_id: parentId });
    const budget = await runBudget(modules.storage, runId);
    const result = await modules.distiller.distill(distillRequestFor(checkpoint, parent), { runId, provider, budget });
    if (result === null) throw new CliError('the Distiller did not run for the explicit distill trigger');
    deps.io.stdout(renderDistill(formatCheckpointRef(invocation.ref), result));
    return EXIT_OK;
  });
}
