/**
 * Shared test doubles for the CLI:
 * - a captured terminal;
 * - fake modules, where every method is a vitest spy that returns a fixed, contract-typed value;
 * - a spy view over all of them.
 * Nothing here touches a store, git or the network.
 */
import path from 'node:path';
import { vi } from 'vitest';
import type { BundleManifest, BundleScanReport, ExportOptions, ExportTarget, WriteBundleOptions } from '../../../src/bundle/index.js';
import type { CliDeps, CliIo, CliModules } from '../../../src/cli/index.js';
import type { RestoredCheckpointInput, ResumeContext } from '../../../src/context/index.js';
import type { DistillBudget, DistillerProvider, DistillRequest, DistillResult } from '../../../src/distill/index.js';
import type { CheckpointDiff, CheckpointRef, RestoredCheckpoint, RollbackResult } from '../../../src/engine/index.js';
import type { AgentStateObject, Checkpoint, Run, SemanticProjection, SideEffect } from '../../../src/model/types.js';
import type { ProjectionQuery, ReindexCounts } from '../../../src/storage/index.js';
import type { CheckpointPanes, InspectorHandle } from '../../../src/ui/index.js';

export const RUN_ID = `run_01J9${'Z'.repeat(22)}`;
export const FORKED_RUN_ID = `run_01J9${'Y'.repeat(22)}`;
export const REF_1 = `${RUN_ID}:c_1`;
export const REF_2 = `${RUN_ID}:c_2`;
/** A cwd no fake ever reads; commands only resolve paths against it. */
export const CWD = path.resolve(path.sep, 'nonexistent', 'ckpt-cli-unit');
export const COMMIT = 'a'.repeat(40);
export const HASH = 'b'.repeat(64);
const CREATED = '2026-01-01T00:00:00.000Z';

export interface CaptureOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replayed in order, one per prompt; '' (end of input) once exhausted. */
  readonly answers?: readonly string[];
  readonly stdin?: string;
}

/** A terminal that records what the CLI writes and answers its prompts from a script. */
export class CapturedIo implements CliIo {
  out = '';
  err = '';
  readonly prompts: string[] = [];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly #answers: string[];
  readonly #stdin: string;

  constructor(options: CaptureOptions = {}) {
    this.cwd = options.cwd ?? CWD;
    this.env = options.env ?? {};
    this.#answers = [...(options.answers ?? [])];
    this.#stdin = options.stdin ?? '';
  }

  stdout(text: string): void {
    this.out += text;
  }

  stderr(text: string): void {
    this.err += text;
  }

  async prompt(question: string): Promise<string> {
    this.prompts.push(question);
    return this.#answers.shift() ?? '';
  }

  async readStdin(): Promise<string> {
    return this.#stdin;
  }
}

export function captureIo(options?: CaptureOptions): CapturedIo {
  return new CapturedIo(options);
}

export function ref(checkpointId: string, runId: string = RUN_ID): CheckpointRef {
  return { runId, checkpointId };
}

function run(runId: string, forkedFrom: CheckpointRef | null): Run {
  return {
    run_id: runId,
    parent_run_id: forkedFrom?.runId ?? null,
    forked_from_checkpoint: forkedFrom?.checkpointId ?? null,
    agent: 'claude-code',
    created_at: CREATED,
  };
}

function checkpoint(n: number): Checkpoint {
  return {
    schemaVersion: 1,
    checkpoint_id: `c_${n}`,
    run_id: RUN_ID,
    parent_checkpoint_id: n === 1 ? null : `c_${n - 1}`,
    label: null,
    state_blob: { sha256: HASH, size: 128 },
    state_hash: HASH,
    workspace_commit: COMMIT,
    ledger_seq: 3 * n,
    usage: { input_tokens: 0, output_tokens: 0 },
    created_at: CREATED,
  };
}

function state(n: number): AgentStateObject {
  return {
    schemaVersion: 1,
    run_id: RUN_ID,
    checkpoint_id: `c_${n}`,
    ledger_seq: 3 * n,
    workspace_commit: COMMIT,
    pending_intent: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function sideEffect(i: number): SideEffect {
  return { type: 'email.send', target: `ops${i}@example.invalid`, request_hash: HASH, response_hash: HASH, reversibility: 'irreversible' };
}

/** Fresh module return values, typed by each module's contract. */
export function makeFixtures() {
  const c1 = checkpoint(1);
  const c2 = checkpoint(2);
  const effects = [sideEffect(1), sideEffect(2)];
  const restored: RestoredCheckpoint = { checkpoint: c2, state: state(2), worktreePath: path.join(CWD, 'worktree'), pendingIntent: [] };
  const resumeContext: ResumeContext = {
    systemPreamble: 'Resuming run from c_2.\n',
    state: state(2),
    workspaceCommit: COMMIT,
    hydratedEvents: [],
    tokenEstimate: 42,
  };
  const rollback: RollbackResult = { restored: c1, warnings: effects };
  const diff: CheckpointDiff = {
    state: [{ op: 'replace', path: '/ledger_seq', value: 6 }],
    workspace: [
      { status: 'M', path: 'app.txt' },
      { status: 'R100', path: 'b.txt', oldPath: 'a.txt' },
    ],
    ledger: { a: [0, 3], b: [3, 6] },
    sideEffects: effects,
  };
  const panes: CheckpointPanes = {
    state: state(2),
    workspace: { commit: COMMIT, changedPaths: ['app.txt'] },
    ledger: { range: [3, 6], toolsUsed: ['Edit'], modelCalls: 1, sideEffects: effects, events: [] },
  };
  const report: BundleScanReport = { filesScanned: 4, toolOutputs: 2, envEntries: 1, hits: [] };
  const manifest: BundleManifest = {
    schemaVersion: 1,
    runIds: [RUN_ID],
    checkpointIds: ['c_1', 'c_2'],
    blobRefs: [`sha256:${HASH}`],
    gitRefs: [{ ref: `refs/checkpoints/${RUN_ID}/c_1`, sha: COMMIT }],
    unsafe: false,
  };
  const reindex: ReindexCounts = { runs: 2, checkpoints: 2, events: 6, projections: 1, claims: 0 };
  const projection: SemanticProjection = {
    id: 'proj_fixture',
    checkpointId: 'c_2',
    source: 'distilled',
    distiller: { provider: 'stub', model: 'stub-model', promptVersion: 'distill-v1' },
    input: { stateHash: HASH, ledgerRange: [3, 6], workspaceCommit: COMMIT },
    claims: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.00005 },
    createdAt: CREATED,
  };
  const distillResult: DistillResult = { projection, rejectedClaims: 0, budget: { runId: RUN_ID, capUsd: 0.25, spentUsd: 0.00005 } };
  return {
    runs: [run(RUN_ID, null), run(FORKED_RUN_ID, ref('c_1'))],
    checkpoints: [c1, c2],
    forkedRun: run(FORKED_RUN_ID, ref('c_2')),
    restored,
    resumeContext,
    rollback,
    diff,
    panes,
    report,
    manifest,
    reindex,
    distillResult,
    bundlePath: path.join(CWD, 'checkpoint.bundle'),
  };
}

export type Fixtures = ReturnType<typeof makeFixtures>;

/** Every CliModules method as a spy returning `values`. */
export function fakeModules(values: Fixtures = makeFixtures()) {
  const handle = { url: 'http://127.0.0.1:43210/', close: vi.fn(async (): Promise<void> => undefined) };
  const byId = (id: string): Checkpoint => {
    const found = values.checkpoints.find((cp) => cp.checkpoint_id === id);
    if (found === undefined) throw Object.assign(new Error(`no checkpoint ${id}`), { code: 'ERR_NOT_FOUND' });
    return found;
  };
  const modules = {
    storage: {
      listRuns: vi.fn(async (): Promise<Run[]> => values.runs),
      listCheckpoints: vi.fn(async (_runId: string): Promise<Checkpoint[]> => values.checkpoints),
      getCheckpoint: vi.fn(async (at: { readonly run_id: string; readonly checkpoint_id: string }): Promise<Checkpoint> => byId(at.checkpoint_id)),
      listProjections: vi.fn(async (_query: ProjectionQuery): Promise<SemanticProjection[]> => []),
      reindex: vi.fn(async (): Promise<ReindexCounts> => values.reindex),
    },
    engine: {
      resume: vi.fn(async (_ref: CheckpointRef): Promise<RestoredCheckpoint> => values.restored),
      fork: vi.fn(async (_ref: CheckpointRef): Promise<Run> => values.forkedRun),
      rollback: vi.fn(async (_ref: CheckpointRef): Promise<RollbackResult> => values.rollback),
      diff: vi.fn(async (_a: CheckpointRef, _b: CheckpointRef): Promise<CheckpointDiff> => values.diff),
    },
    context: {
      buildResumeContext: vi.fn(async (_restored: RestoredCheckpointInput): Promise<ResumeContext> => values.resumeContext),
    },
    bundle: {
      planExport: vi.fn(
        async (_target: ExportTarget, _options?: ExportOptions): Promise<{ manifest: BundleManifest; report: BundleScanReport }> => ({
          manifest: values.manifest,
          report: values.report,
        }),
      ),
      writeBundle: vi.fn(async (_manifest: BundleManifest, _options: WriteBundleOptions): Promise<string> => values.bundlePath),
      importBundle: vi.fn(async (_bundlePath: string): Promise<{ runIds: string[] }> => ({ runIds: [RUN_ID] })),
    },
    inspector: {
      checkpoint: vi.fn(async (_id: string): Promise<CheckpointPanes> => values.panes),
      start: vi.fn(async (_options: { readonly port: number }): Promise<InspectorHandle> => handle),
    },
    distiller: {
      distill: vi.fn(
        async (
          _request: DistillRequest,
          _options: { readonly runId: string; readonly provider: DistillerProvider; readonly budget: DistillBudget },
        ): Promise<DistillResult | null> => values.distillResult,
      ),
    },
    hooks: { handleHook: vi.fn(async (_payload: unknown): Promise<string | null> => 'evt_fake') },
    close: vi.fn(async (): Promise<void> => undefined),
  };
  const contract: CliModules = modules;
  return { modules, contract, handle, values };
}

/** CliDeps whose every member is a spy over fake modules, a fake runner and a stub provider. */
export function fakeDeps(io: CapturedIo = captureIo()) {
  const fake = fakeModules();
  const provider = {
    name: 'stub',
    model: 'stub-model',
    complete: vi.fn(async (_prompt: string) => ({ text: '{"claims": []}', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })),
  };
  const runner = { run: vi.fn(async (_args: string[]): Promise<number> => 0) };
  const deps = {
    io,
    openModules: vi.fn(async (_io: CliIo): Promise<CliModules> => fake.contract),
    createRunner: vi.fn((_io: CliIo) => runner),
    createProvider: vi.fn(async (_io: CliIo): Promise<DistillerProvider> => provider),
    untilShutdown: vi.fn(async (): Promise<void> => undefined),
  };
  const contract: CliDeps = deps;
  return { ...fake, deps, depsContract: contract, provider, runner, io };
}

export type FakeDeps = ReturnType<typeof fakeDeps>;

export interface Spy {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** Every spy reachable from a fake: `storage.listRuns`, `close`, `deps.openModules`, `runner.run`, `provider.complete`. */
export function spiesOf(fx: FakeDeps): Map<string, Spy> {
  const spies = new Map<string, Spy>();
  for (const [group, member] of Object.entries(fx.modules)) {
    if (vi.isMockFunction(member)) {
      spies.set(group, member);
      continue;
    }
    for (const [name, fn] of Object.entries(member as Record<string, unknown>)) {
      if (vi.isMockFunction(fn)) spies.set(`${group}.${name}`, fn);
    }
  }
  for (const [name, fn] of Object.entries(fx.deps)) {
    if (vi.isMockFunction(fn)) spies.set(`deps.${name}`, fn);
  }
  spies.set('runner.run', fx.runner.run);
  spies.set('provider.complete', fx.provider.complete);
  return spies;
}

/** Names of the spies that were called at least once. */
export function calledSpies(fx: FakeDeps): string[] {
  return [...spiesOf(fx)].filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);
}
