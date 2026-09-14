/**
 * Checkpoint Engine — SPEC-006: create, resume, fork, rollback, diff and exact replay over the checkpoint
 * graph, against StorageBackend. Model-agnostic: nothing here calls an LLM or the network.
 *
 * Responsibilities and boundaries:
 * - Observations (`record`) are sanitized through Redaction before they reach storage (SPEC-003).
 * - `checkpoint` builds the sanitized staging tree (snapshot.ts) and hands it to storage's
 *   `createCheckpoint`, which writes CAS → ref → `checkpoint.created` → index atomically and assigns
 *   `ledger_seq` (DEC-018(2c)); the engine never appends a second `checkpoint.created`.
 * - Workspaces are only ever written inside a run's EXECUTION WORKTREE (`<git common dir>/ckpt/worktrees/<run>`
 *   by default), never in the user's worktree, index or `refs/heads/*`.
 * - One writer per run: operations on a run are serialised here, and storage's run lock rejects a second
 *   process (ERR_RUN_LOCKED).
 *
 * The engine keeps no state of its own that is not derived from the ledger. Per run it folds the events:
 * - the current checkpoint: the latest `checkpoint.created`, `agent.resumed` or `agent.rolled_back`;
 * - the workspace: the user's worktree root until the run has an execution worktree (after
 *   `agent.resumed`, `agent.rolled_back` or `agent.forked`);
 * - the tool / side-effect events that pending intent and side-effect warnings are derived from;
 * - cumulative token usage from `model.responded`.
 * So a fresh process (after `kill -9`) reaches the same view from the durable ledger.
 *
 * Engine-authored lineage events (`agent.resumed`, `agent.forked`, `agent.rolled_back`) carry only
 * ckpt-generated identifiers (run and checkpoint ids, commit ids, seqs). Each payload is validated against its
 * exact per-event-type schema (lineage.ts, DEC-024) BEFORE the worktree, a forked run or the ledger is
 * written, and is not routed through `sanitize()` (whose high-entropy detector would redact commit ids).
 * Caller-supplied strings are never exempt: `run.created`'s agent name (also stored in the run record) and
 * checkpoint labels are sanitized.
 */
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { derivePendingIntent } from '../ledger/pending-intent.js';
import { pendingIntentAt } from './resume-intent.js';
import { verifyChain } from '../ledger/verify-chain.js';
import type { Checkpoint, LedgerEvent, LedgerEventDraft, Run, SideEffect } from '../model/types.js';
import { sanitize } from '../redact/index.js';
import { STORE_DIR_NAME } from '../storage/layout.js';
import type { StorageBackend } from '../storage/types.js';
import { EngineError } from './errors.js';
import { WorkspaceGit } from './git.js';
import { diffJson } from './json-patch.js';
import { lineagePayload } from './lineage.js';
import { sanitizePayload } from './observations.js';
import { assertRunId, toStorageRef } from './refs.js';
import { deriveSideEffects } from './side-effects.js';
import { MAX_SNAPSHOT_FILE_BYTES, buildSnapshot, type SnapshotCache } from './snapshot.js';
import type {
  CheckpointDiff,
  CheckpointOptions,
  CheckpointRef,
  DistillRequest,
  DistillRequestPort,
  ReplayOptions,
  RestoredCheckpoint,
  RollbackResult,
} from './types.js';

/** Event types observations may not use: storage emits `checkpoint.created`, the engine the lineage events. */
export const ENGINE_OWNED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.created',
  'checkpoint.created',
  'agent.resumed',
  'agent.forked',
  'agent.rolled_back',
]);

const LATEST_SEQ = Number.MAX_SAFE_INTEGER;
const MAX_LINEAGE_DEPTH = 10_000;

export interface CheckpointEngineOptions {
  readonly backend: StorageBackend;
  /** Any directory inside the user's git worktree (the same repository the backend stores into). */
  readonly repoDir: string;
  /** Parent directory of execution worktrees. Default `<git common dir>/ckpt/worktrees`. */
  readonly worktreesDir?: string;
  /** Where private staging directories are created. Default the OS temp dir. */
  readonly tmpDir?: string;
  /** Receives a `DistillRequest` for each labelled checkpoint, after `checkpoint()` returns. */
  readonly distill?: DistillRequestPort;
  /** Snapshot policy (e.g. gitignored paths): return false to leave a path out. Secret paths are always out. */
  readonly snapshotFilter?: (relPath: string) => boolean;
  /** Per-file snapshot limit. Default SPEC-002's 1 GB. */
  readonly maxFileBytes?: number;
  /** Epoch nanoseconds, for the change-detection racy-clean guard. */
  readonly nowNs?: () => bigint;
}

interface ForkOrigin {
  readonly runId: string;
  readonly checkpointId: string;
  readonly ledgerSeq: number;
}

/** What the engine folds out of one run's ledger. */
interface RunView {
  seq: number;
  currentCheckpointId: string | null;
  workspace: 'repo' | 'execution';
  forkedFrom: ForkOrigin | null;
  forkCommit: string | null;
  readonly intentEvents: LedgerEvent[];
  usage: { input_tokens: number; output_tokens: number };
  cache: SnapshotCache | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): EngineError {
  return new EngineError('ERR_INVALID_INPUT', message);
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class CheckpointEngine {
  readonly #backend: StorageBackend;
  readonly #git: WorkspaceGit;
  readonly #worktreesDir: string;
  readonly #tmpDir: string;
  readonly #distill: DistillRequestPort | undefined;
  readonly #snapshotFilter: ((relPath: string) => boolean) | undefined;
  readonly #maxFileBytes: number;
  readonly #nowNs: () => bigint;
  readonly #views = new Map<string, RunView>();
  readonly #queues = new Map<string, Promise<void>>();

  private constructor(options: CheckpointEngineOptions, git: WorkspaceGit) {
    this.#backend = options.backend;
    this.#git = git;
    this.#worktreesDir = path.resolve(options.worktreesDir ?? path.join(git.commonDir, 'ckpt', 'worktrees'));
    this.#tmpDir = options.tmpDir ?? os.tmpdir();
    this.#distill = options.distill;
    this.#snapshotFilter = options.snapshotFilter;
    this.#maxFileBytes = options.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
    this.#nowNs = options.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
  }

  static async open(options: CheckpointEngineOptions): Promise<CheckpointEngine> {
    if (!isRecord(options) || !isRecord(options.backend) || typeof options.repoDir !== 'string') {
      throw invalid('CheckpointEngine.open needs {backend, repoDir}');
    }
    if (options.maxFileBytes !== undefined && !(Number.isSafeInteger(options.maxFileBytes) && options.maxFileBytes >= 0)) {
      throw invalid('maxFileBytes must be a non-negative integer');
    }
    return new CheckpointEngine(options, await WorkspaceGit.open(options.repoDir));
  }

  /** Top level of the user's worktree. */
  get repoRoot(): string {
    return this.#git.workTree;
  }

  /** The execution worktree a run is restored into. */
  worktreePath(runId: string): string {
    assertRunId(runId);
    return path.join(this.#worktreesDir, runId);
  }

  /** The directory `checkpoint(runId)` snapshots right now. */
  async workspaceDir(runId: string): Promise<string> {
    assertRunId(runId);
    return this.#serial(runId, async () => this.#workspaceOf(runId, await this.#view(runId)));
  }

  // ── ingestion ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Create a run whose workspace is the user's worktree (read-only) until it is resumed or rolled back.
   * `agent` is caller-supplied free text, so it is sanitized before anything is persisted: the run record,
   * the index, every forked run that copies it and `run.created` only ever hold the redacted name
   * (SPEC-003, DEC-024(b)).
   */
  async startRun(input: { readonly agent: string }): Promise<Run> {
    if (!isRecord(input) || typeof input.agent !== 'string' || input.agent.trim() === '') {
      throw invalid('startRun needs a non-empty agent');
    }
    const agent = sanitize(input.agent).output;
    const run = await this.#backend.createRun({ agent });
    return this.#serial(run.run_id, async () => {
      const view = await this.#view(run.run_id);
      const event = await this.#backend.appendEvent(run.run_id, {
        type: 'run.created',
        actor: 'runtime',
        payload: sanitizePayload('run.created', { agent, workspace: 'repo' }),
      });
      this.#fold(view, event);
      return run;
    });
  }

  /**
   * Append observations (from an adapter or SDK) in order. Each payload is sanitized first. Lineage and
   * checkpoint event types are refused with ERR_RESERVED_EVENT.
   */
  async record(observations: readonly LedgerEventDraft[]): Promise<LedgerEvent[]> {
    if (!Array.isArray(observations)) throw invalid('record needs an array of observations');
    const sealed: LedgerEvent[] = [];
    for (const observation of observations as readonly unknown[]) {
      if (!isRecord(observation)) throw invalid('an observation is {run_id, type, actor, payload}');
      const { run_id: runId, type, actor } = observation;
      assertRunId(runId, 'observation.run_id');
      if (typeof type !== 'string') throw invalid('observation.type must be a string');
      if (ENGINE_OWNED_EVENT_TYPES.has(type)) {
        throw new EngineError('ERR_RESERVED_EVENT', `${type} is emitted by the engine or storage, not recorded as an observation`);
      }
      const payload = sanitizePayload(type, observation['payload']);
      const event = await this.#serial(runId, async () => {
        const view = await this.#view(runId);
        const appended = await this.#backend.appendEvent(runId, { type, actor, payload } as LedgerEventDraft);
        this.#fold(view, appended);
        return appended;
      });
      sealed.push(event);
    }
    return sealed;
  }

  // ── SPEC-006 operations ─────────────────────────────────────────────────────────────────────────

  /**
   * State + sanitized workspace commit + ledger cursor, atomically (through storage). A label emits one
   * fire-and-forget `DistillRequest` after this returns; nothing here waits on, or calls, a model.
   */
  async checkpoint(runId: string, options: CheckpointOptions = {}): Promise<Checkpoint> {
    assertRunId(runId);
    if (!isRecord(options)) throw invalid('checkpoint options are {label?}');
    const rawLabel = options.label ?? null;
    if (rawLabel !== null && (typeof rawLabel !== 'string' || rawLabel === '')) throw invalid('label is a non-empty string or null');
    const label = rawLabel === null ? null : sanitize(rawLabel).output;

    const checkpoint = await this.#serial(runId, async () => {
      const view = await this.#view(runId);
      const workspaceDir = this.#workspaceOf(runId, view);
      if (!(await stat(workspaceDir).catch(() => undefined))?.isDirectory()) {
        throw new EngineError('ERR_WORKSPACE', `the workspace of ${runId} (${workspaceDir}) is missing; resume or fork a checkpoint to restore it`);
      }
      const parentId = view.currentCheckpointId;
      const parentCommit =
        parentId !== null
          ? (await this.#backend.getCheckpoint({ run_id: runId, checkpoint_id: parentId })).workspace_commit
          : view.forkCommit;

      const snapshot = await buildSnapshot({
        workspaceDir,
        parentCommit,
        readTree: (commit) => this.#git.readTree(commit),
        cache: view.cache,
        objectFormat: this.#git.objectFormat,
        tmpDir: this.#tmpDir,
        maxFileBytes: this.#maxFileBytes,
        skipRootEntries: new Set(view.workspace === 'repo' ? [STORE_DIR_NAME] : []),
        include: this.#snapshotFilter,
        nowNs: this.#nowNs,
      });
      try {
        for (const skipped of snapshot.skipped) {
          const event = await this.#backend.appendEvent(runId, {
            type: 'workspace.file_skipped',
            actor: 'runtime',
            payload: sanitizePayload('workspace.file_skipped', {
              path: skipped.path,
              size: skipped.size,
              reason: skipped.reason,
              limit_bytes: this.#maxFileBytes,
            }),
          });
          this.#fold(view, event);
        }

        const created = await this.#backend.createCheckpoint({
          run_id: runId,
          parent_checkpoint_id: parentId,
          label,
          pending_intent: derivePendingIntent(view.intentEvents),
          usage: { ...view.usage },
          stagingDir: snapshot.stagingDir,
          ...(snapshot.changes === undefined ? {} : { changes: snapshot.changes }),
        });
        // Storage appended checkpoint.created at created.ledger_seq; advance the fold past it.
        if (created.ledger_seq === view.seq + 1) {
          view.seq = created.ledger_seq;
          view.currentCheckpointId = created.checkpoint_id;
        }
        view.cache = { workspaceDir, baseCommit: created.workspace_commit, files: snapshot.files };
        return created;
      } catch (err) {
        view.cache = undefined;
        throw err;
      } finally {
        await snapshot.cleanup();
      }
    });

    if (label !== null && this.#distill !== undefined) this.#emitDistillRequest(this.#distill, checkpoint, label);
    return checkpoint;
  }

  /**
   * Check the checkpoint's workspace out into the run's execution worktree, load its state, recompute pending
   * intent from ledger acknowledgements as of the checkpoint's cursor (DEC-025, see resume-intent.ts), and
   * emit `agent.resumed`. Never replays the transcript.
   */
  async resume(ref: CheckpointRef): Promise<RestoredCheckpoint> {
    const at = toStorageRef(ref);
    return this.#serial(at.run_id, async () => {
      const checkpoint = await this.#backend.getCheckpoint(at);
      const state = await this.#backend.getState(at);
      // Validated before the worktree or the ledger is written (DEC-024(a)).
      const payload = lineagePayload(
        'agent.resumed',
        { checkpoint_id: checkpoint.checkpoint_id, ledger_seq: checkpoint.ledger_seq, workspace_commit: checkpoint.workspace_commit },
        this.#git.objectFormat,
      );
      const worktreePath = this.worktreePath(at.run_id);
      await this.#git.materialize(worktreePath, checkpoint.workspace_commit);

      const view = await this.#view(at.run_id);
      // As of the checkpoint's cursor, plus later requests that were never resolved (DEC-025).
      const pendingIntent = pendingIntentAt(view.intentEvents, checkpoint.ledger_seq);
      const event = await this.#backend.appendEvent(at.run_id, { type: 'agent.resumed', actor: 'runtime', payload });
      this.#fold(view, event);
      return { checkpoint, state, worktreePath, pendingIntent };
    });
  }

  /**
   * A new run with `parent_run_id` and `forked_from_checkpoint`, whose execution worktree starts at the
   * source `workspace_commit`, and whose first checkpoint builds on that commit. Emits `agent.forked` on
   * the new run; the source run is only read.
   */
  async fork(ref: CheckpointRef): Promise<Run> {
    const at = toStorageRef(ref);
    const source = await this.#backend.getCheckpoint(at);
    // Validated before the forked run, its worktree or its ledger is written (DEC-024(a)).
    const payload = lineagePayload(
      'agent.forked',
      {
        parent_run_id: source.run_id,
        forked_from_checkpoint: source.checkpoint_id,
        ledger_seq: source.ledger_seq,
        workspace_commit: source.workspace_commit,
      },
      this.#git.objectFormat,
    );
    const run = await this.#backend.fork(at);
    return this.#serial(run.run_id, async () => {
      await this.#git.materialize(this.worktreePath(run.run_id), source.workspace_commit);
      const view = await this.#view(run.run_id);
      const event = await this.#backend.appendEvent(run.run_id, { type: 'agent.forked', actor: 'runtime', payload });
      this.#fold(view, event);
      return run;
    });
  }

  /**
   * Restore managed, reversible state only (the workspace and the run's current checkpoint) to `ref`, and
   * return every side effect recorded after it as a warning. External effects are never undone.
   */
  async rollback(ref: CheckpointRef): Promise<RollbackResult> {
    const at = toStorageRef(ref);
    return this.#serial(at.run_id, async () => {
      const restored = await this.#backend.getCheckpoint(at);
      const view = await this.#view(at.run_id);
      const warnings = deriveSideEffects(view.intentEvents, restored.ledger_seq, view.seq);
      // Validated before the worktree or the ledger is written (DEC-024(a)).
      const payload = lineagePayload(
        'agent.rolled_back',
        {
          checkpoint_id: restored.checkpoint_id,
          ledger_seq: restored.ledger_seq,
          workspace_commit: restored.workspace_commit,
          side_effect_warnings: warnings.length,
        },
        this.#git.objectFormat,
      );
      await this.#git.materialize(this.worktreePath(at.run_id), restored.workspace_commit);
      const event = await this.#backend.appendEvent(at.run_id, { type: 'agent.rolled_back', actor: 'runtime', payload });
      this.#fold(view, event);
      return { restored, warnings };
    });
  }

  /** Four parts: state patch, `git diff --name-status`, ledger ranges beyond the common ancestor, side effects in them. */
  async diff(a: CheckpointRef, b: CheckpointRef): Promise<CheckpointDiff> {
    const refA = toStorageRef(a, 'a');
    const refB = toStorageRef(b, 'b');
    const [cpA, cpB] = await Promise.all([this.#backend.getCheckpoint(refA), this.#backend.getCheckpoint(refB)]);
    const [stateA, stateB] = await Promise.all([this.#backend.getState(refA), this.#backend.getState(refB)]);
    const workspace = await this.#git.diffNameStatus(cpA.workspace_commit, cpB.workspace_commit);

    const [lineageA, lineageB] = await Promise.all([this.#lineage(cpA), this.#lineage(cpB)]);
    const common = lineageA.find((entry) => lineageB.some((other) => other.runId === entry.runId));
    const commonSeq =
      common === undefined ? undefined : Math.min(common.seq, lineageB.find((other) => other.runId === common.runId)?.seq ?? common.seq);
    const start = (cp: Checkpoint): number => (common !== undefined && commonSeq !== undefined && cp.run_id === common.runId ? commonSeq : 0);
    const rangeA: [number, number] = [Math.min(start(cpA), cpA.ledger_seq), cpA.ledger_seq];
    const rangeB: [number, number] = [Math.min(start(cpB), cpB.ledger_seq), cpB.ledger_seq];

    const sideEffects: SideEffect[] = [
      ...(await this.#sideEffectsIn(cpA.run_id, rangeA)),
      ...(await this.#sideEffectsIn(cpB.run_id, rangeB)),
    ];
    return { state: diffJson(stateA, stateB), workspace, ledger: { a: rangeA, b: rangeB }, sideEffects };
  }

  /**
   * The ledger events up to the checkpoint's cursor. With `exact`, the sequence must be complete from seq 1
   * and its hash chain must verify (ERR_CORRUPT otherwise): recorded model and tool outputs are returned
   * as recorded, and no provider, tool or network is called in either mode.
   */
  async replay(ref: CheckpointRef, options: ReplayOptions): Promise<LedgerEvent[]> {
    const at = toStorageRef(ref);
    if (!isRecord(options) || typeof options.exact !== 'boolean') throw invalid('replay options are {exact: boolean}');
    const checkpoint = await this.#backend.getCheckpoint(at);
    const events = await this.#backend.getEvents(at.run_id, { fromSeq: 1, toSeq: checkpoint.ledger_seq });
    if (options.exact) {
      if (events.length !== checkpoint.ledger_seq || events.some((event, i) => event.seq !== i + 1)) {
        throw new EngineError('ERR_CORRUPT', `ledger of ${at.run_id} is incomplete up to seq ${checkpoint.ledger_seq}`);
      }
      const chain = verifyChain(events);
      if (!chain.ok) throw new EngineError('ERR_CORRUPT', `ledger of ${at.run_id} is broken at seq ${chain.brokenAtSeq}`);
    }
    return events;
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────

  #emitDistillRequest(port: DistillRequestPort, checkpoint: Checkpoint, label: string): void {
    const message: DistillRequest = {
      run_id: checkpoint.run_id,
      checkpoint_id: checkpoint.checkpoint_id,
      label,
      ledger_seq: checkpoint.ledger_seq,
      state_hash: checkpoint.state_hash,
      workspace_commit: checkpoint.workspace_commit,
    };
    // Fire and forget, after checkpoint() has returned: a port never delays or fails a checkpoint.
    setImmediate(() => {
      try {
        const pending = port.request(message);
        if (pending !== undefined && typeof pending.then === 'function') pending.then(undefined, () => undefined);
      } catch {
        // ignored by design (DEC-006: distillation is decoupled from the durability path)
      }
    });
  }

  #workspaceOf(runId: string, view: RunView): string {
    return view.workspace === 'execution' ? this.worktreePath(runId) : this.#git.workTree;
  }

  /** Serialise operations on one run (single writer per run within this process). */
  #serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(runId, tail);
    void tail.then(() => {
      if (this.#queues.get(runId) === tail) this.#queues.delete(runId);
    });
    return result;
  }

  /** The run's folded view, brought up to the durable ledger head. Call only inside #serial(runId). */
  async #view(runId: string): Promise<RunView> {
    let view = this.#views.get(runId);
    if (view === undefined) {
      view = {
        seq: 0,
        currentCheckpointId: null,
        workspace: 'repo',
        forkedFrom: null,
        forkCommit: null,
        intentEvents: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        cache: undefined,
      };
    }
    const events = await this.#backend.getEvents(runId, { fromSeq: view.seq + 1, toSeq: LATEST_SEQ });
    for (const event of events) this.#fold(view, event);
    this.#views.set(runId, view);
    return view;
  }

  #fold(view: RunView, event: LedgerEvent): void {
    if (event.seq !== view.seq + 1) {
      throw new EngineError('ERR_CORRUPT', `ledger of ${event.run_id}: expected seq ${view.seq + 1}, got ${event.seq}`);
    }
    view.seq = event.seq;
    const payload = event.payload ?? {};
    switch (event.type) {
      case 'checkpoint.created':
        if (typeof payload['checkpoint_id'] === 'string') view.currentCheckpointId = payload['checkpoint_id'];
        break;
      case 'agent.resumed':
      case 'agent.rolled_back':
        if (typeof payload['checkpoint_id'] === 'string') view.currentCheckpointId = payload['checkpoint_id'];
        view.workspace = 'execution';
        view.cache = undefined;
        break;
      case 'agent.forked': {
        view.workspace = 'execution';
        view.cache = undefined;
        const { parent_run_id: runId, forked_from_checkpoint: checkpointId, ledger_seq: ledgerSeq, workspace_commit: commit } = payload;
        if (typeof commit === 'string') view.forkCommit = commit;
        if (typeof runId === 'string' && typeof checkpointId === 'string' && typeof ledgerSeq === 'number') {
          view.forkedFrom = { runId, checkpointId, ledgerSeq };
        }
        break;
      }
      case 'tool.requested':
      case 'tool.completed':
      case 'tool.failed':
      case 'side_effect.requested':
      case 'side_effect.committed':
        view.intentEvents.push(event);
        break;
      case 'model.responded': {
        const usage = isRecord(payload['usage']) ? payload['usage'] : payload;
        view.usage.input_tokens += tokenCount(usage['input_tokens']);
        view.usage.output_tokens += tokenCount(usage['output_tokens']);
        break;
      }
      default:
        break;
    }
  }

  /** `[{runId, seq}]` from the checkpoint up through the runs it was forked from. */
  async #lineage(checkpoint: Checkpoint): Promise<Array<{ runId: string; seq: number }>> {
    const chain = [{ runId: checkpoint.run_id, seq: checkpoint.ledger_seq }];
    let runId = checkpoint.run_id;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      const current = runId;
      const origin = (await this.#serial(current, () => this.#view(current))).forkedFrom;
      if (origin === null || chain.some((entry) => entry.runId === origin.runId)) break;
      chain.push({ runId: origin.runId, seq: origin.ledgerSeq });
      runId = origin.runId;
    }
    return chain;
  }

  async #sideEffectsIn(runId: string, [after, upto]: [number, number]): Promise<SideEffect[]> {
    const view = await this.#serial(runId, () => this.#view(runId));
    return deriveSideEffects(view.intentEvents, after, upto);
  }
}
