/**
 * The modules `ckpt` dispatches to (SPEC-013 "Commands"), and their composition over the local store.
 *
 * This is the composition root's wiring. It opens Local Storage and the Checkpoint Engine for the git worktree the
 * command runs in, then gives each command a narrow view of the module that owns the operation. The CLI owns no
 * checkpoint, ledger, redaction or storage semantics: every read and every mutation is a call into its owning module.
 */
import { createHookHandler, createRunner, type HookHandler, type Runner } from '../adapters/claude-code/index.js';
import { createBundleService, type BundleService } from '../bundle/index.js';
import { createContextBuilder, type ClaimSource, type ContextBuilder, type ContextGit } from '../context/index.js';
import {
  BlobProjectionStore,
  distillForTrigger,
  storageSource,
  type DistillBudget,
  type DistillerProvider,
  type DistillRequest,
  type DistillResult,
} from '../distill/index.js';
import { CheckpointEngine, WorkspaceGit } from '../engine/index.js';
import { LocalBackend, type StorageBackend } from '../storage/index.js';
import { InspectorViews, startInspector, type CheckpointPanes, type InspectorHandle } from '../ui/index.js';
import type { CliIo } from './io.js';

/** Local Storage reads plus `reindex()`. */
export type CliStorage = Pick<StorageBackend, 'listRuns' | 'listCheckpoints' | 'getCheckpoint' | 'listProjections' | 'reindex'>;

/** Checkpoint Engine operations. */
export type CliEngine = Pick<CheckpointEngine, 'resume' | 'fork' | 'rollback' | 'diff'>;

export interface CliInspector {
  /** The STATE, WORKSPACE and LEDGER panes of `run_<ulid>:c_<n>`, read from Storage and git only (SPEC-012 views). */
  checkpoint(id: string): Promise<CheckpointPanes>;
  /** SPEC-012 `startInspector` over this store. */
  start(options: { readonly port: number }): Promise<InspectorHandle>;
}

export interface CliDistiller {
  /** One SPEC-007 distillation of a checkpoint of `runId`, through the Distiller's explicit `distill` trigger. */
  distill(
    request: DistillRequest,
    options: { readonly runId: string; readonly provider: DistillerProvider; readonly budget: DistillBudget },
  ): Promise<DistillResult | null>;
}

export interface CliModules {
  readonly storage: CliStorage;
  readonly engine: CliEngine;
  readonly context: Pick<ContextBuilder, 'buildResumeContext'>;
  readonly bundle: Pick<BundleService, 'planExport' | 'writeBundle' | 'importBundle'>;
  readonly inspector: CliInspector;
  readonly distiller: CliDistiller;
  readonly hooks: Pick<HookHandler, 'handleHook'>;
  /** Closes the store, releasing its run locks. */
  close(): Promise<void>;
}

/**
 * The Context Builder's ClaimSource over Storage's durable projection index (DEC-036(1), DEC-040): what one checkpoint
 * has recorded, by run and checkpoint id. Distilled projections are the builder's `projections` (it uses the newest).
 * A declared projection holds the agent_declared claims the Engine stored from the State SDK.
 */
export function storageClaims(storage: Pick<StorageBackend, 'listProjections'>): ClaimSource {
  return {
    async claimsAt(checkpoint) {
      const projections = await storage.listProjections({ runId: checkpoint.run_id, checkpointId: checkpoint.checkpoint_id });
      return {
        projections: projections.filter((projection) => projection.source === 'distilled'),
        declared: projections.filter((projection) => projection.source === 'declared').flatMap((projection) => projection.claims),
      };
    },
  };
}

/** Opens the git worktree reader on first use, so commands that never diff trees never spawn git for it. */
function lazyGit(repoDir: string): ContextGit {
  let opened: Promise<WorkspaceGit> | undefined;
  return {
    async diffNameStatus(a, b) {
      opened ??= WorkspaceGit.open(repoDir);
      return (await opened).diffNameStatus(a, b);
    },
  };
}

/** Opens the store and Engine of the worktree containing `io.cwd`. The caller closes it. */
export async function openLocalModules(io: CliIo): Promise<CliModules> {
  const backend = await LocalBackend.open({ repoDir: io.cwd });
  try {
    // No `distill` port: the CLI creates no labelled checkpoint, so nothing it composes requests a distillation.
    const engine = await CheckpointEngine.open({ backend, repoDir: io.cwd });
    const listRuns = () => backend.listRuns();
    const views = new InspectorViews({ backend, engine, listRuns });
    return {
      storage: backend,
      engine,
      context: createContextBuilder({ storage: backend, git: lazyGit(engine.repoRoot), claims: storageClaims(backend) }),
      bundle: createBundleService({ backend, outDir: io.cwd }),
      inspector: {
        checkpoint: (id) => views.checkpoint(id),
        start: ({ port }) => startInspector({ port, backend, engine, listRuns }),
      },
      distiller: {
        distill: (request, { runId, provider, budget }) =>
          distillForTrigger('distill', request, { provider, budget, source: storageSource(backend, runId), store: new BlobProjectionStore(backend) }),
      },
      hooks: createHookHandler({ engine, ledger: backend, env: io.env }),
      close: () => backend.close(),
    };
  } catch (err) {
    await backend.close();
    throw err;
  }
}

/**
 * The Claude Code Adapter's runner for `ckpt run claude`. It opens the store itself and closes it before launching
 * claude, because the hook processes claude spawns need the run's writer lock.
 */
export function localRunner(io: CliIo): Pick<Runner, 'run'> {
  return createRunner({
    projectDir: io.cwd,
    env: { ...io.env },
    openEngine: async () => {
      const backend = await LocalBackend.open({ repoDir: io.cwd });
      try {
        return { engine: await CheckpointEngine.open({ backend, repoDir: io.cwd }), close: () => backend.close() };
      } catch (err) {
        await backend.close();
        throw err;
      }
    },
  });
}
