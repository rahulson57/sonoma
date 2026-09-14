/**
 * LocalBackend — the v1 StorageBackend (SPEC-005): SQLite index + CAS + git checkpoint refs, all under
 * `<repo>/.ckpt/`, with zero network access.
 *
 * Sources of truth: runs/<run>/run.json, runs/<run>/events.jsonl (the ledger), CAS blobs and
 * refs/checkpoints/<run>/<checkpoint>. checkpoint.db is only an index and `reindex()` rebuilds it.
 *
 * createCheckpoint visibility ordering (SPEC-005):
 *   git objects (unreferenced) → CAS state blob → git ref → `checkpoint.created` ledger event → index rows.
 * The index rows are written last, in one transaction, so a crash at any earlier point leaves no
 * visible partial checkpoint. On reindex, a checkpoint exists only when its checkpoint.created event,
 * its ref (pointing at the recorded commit) and its state blob are all durable. An orphan ref from a
 * crash before the event is never listed, and the next checkpoint overwrites it.
 *
 * With a parent tree and a `changes` delta, the commit is built on the parent tree and only the written
 * files are read (DEC-019(1)). A delta that does not fit fails with ERR_INVALID_CHANGES before step 1
 * writes any object.
 *
 * Single writer per run: the first write to a run takes `.ckpt/lock/<run>.lock` and holds it until
 * close(). Taking the lock replays anything the log holds that the index does not (roll-forward), so
 * the chain always continues from the durable head. If a write fails midway, the writer is dropped
 * and its lock released, and the next write recovers from disk again.
 *
 * Projections and claims (SPEC-005 "Durable projection-and-claim index", SPEC-015 amendment 4): putProjection
 * writes the projection's canonical JSON to CAS (durable) and only then indexes it and its claims in one
 * transaction. CAS is the source of truth. reindex() rebuilds the rows by scanning CAS for blobs that are
 * valid projections of a durable checkpoint, matched by checkpoint id, state hash and workspace commit.
 * Listing reads the projections back from CAS, so a fresh process sees everything a previous one wrote.
 *
 * Not here: sanitization (the caller's, SPEC-003), checkpoint lifecycle policy (Checkpoint Engine),
 * and the ledger hash chain (S03's ExecutionLedger seals every event).
 */
import { readdir, readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { canonicalJSON } from '../ledger/canonical-json.js';
import { sha256Hex } from '../ledger/hash.js';
import { ExecutionLedger, GENESIS_HEAD, type LedgerClock, type LedgerHead } from '../ledger/ledger.js';
import { verifyChain } from '../ledger/verify-chain.js';
import {
  CURRENT_SCHEMA_VERSION,
  type AgentStateObject,
  type BlobRef,
  type Checkpoint,
  type JsonPayload,
  type LedgerEvent,
  type LedgerEventDraft,
  type Run,
  type SemanticClaim,
  type SemanticProjection,
} from '../model/types.js';
import { validateAgentState, validateCheckpoint, validateSemanticProjection } from '../model/validate.js';
import { BlobStore } from './cas.js';
import { ChangeDetector, type ChangeDetectionFs } from './change-detection.js';
import { StorageError, isStorageError } from './errors.js';
import { ensureDir, errnoCode, fsyncDir, writeExclusive } from './fs-util.js';
import { GitRepo, checkWorkspaceChanges } from './git.js';
import { cryptoRandom, ulid, type RandomSource } from './ids.js';
import { IndexDb, type IndexedProjection, type ProjectionIndexEntry } from './index-db.js';
import {
  CHECKPOINT_ID_PATTERN,
  RUN_ID_PATTERN,
  assertCheckpointId,
  assertRunId,
  checkpointNumber,
  checkpointRefName,
  ensureLayout,
  runPaths,
  storeLayout,
  type RunPaths,
  type StoreLayout,
} from './layout.js';
import { appendEventLine, readEventLog, truncateEventLog } from './ledger-log.js';
import { RunLock } from './lock.js';
import type { CheckpointRef, NewCheckpoint, NewLedgerEvent, NewRun, ProjectionQuery, ReindexCounts, StorageBackend } from './types.js';

/** canonicalJSON sorts members, and `checkpointId` sorts first in a SemanticProjection, so its blob starts with this. */
const PROJECTION_BLOB_PREFIX = Buffer.from('{"checkpointId":', 'utf8');

function stateKey(checkpointId: string, stateHash: string): string {
  return `${checkpointId}\u0000${stateHash}`;
}

/** A valid SemanticProjection parsed from blob bytes, or undefined when the bytes are not one. */
function parseProjection(bytes: Uint8Array): SemanticProjection | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
  const valid = validateSemanticProjection(value);
  return valid.ok ? valid.value : undefined;
}

function projectionEntry(projection: SemanticProjection, checkpoint: Checkpoint, ref: BlobRef): ProjectionIndexEntry {
  return {
    projection_id: projection.id,
    run_id: checkpoint.run_id,
    checkpoint_id: checkpoint.checkpoint_id,
    source: projection.source,
    created_at: projection.createdAt,
    ref: { sha256: ref.sha256, size: ref.size },
    claims: projection.claims.map((claim) => ({ field: claim.field, origin: claim.origin })),
  };
}

/** Crash-injection seams for tests. A throwing hook simulates the process dying at that point. */
export interface StorageFaults {
  /** After the checkpoint's git ref is written, before its checkpoint.created event. */
  afterRefWrite?(at: CheckpointRef): void | Promise<void>;
  /** After the checkpoint.created event is durable, before the index rows. */
  afterCheckpointEvent?(at: CheckpointRef): void | Promise<void>;
}

export interface LocalBackendOptions {
  /** A directory inside the git worktree; the store lives at `<worktree root>/.ckpt`. */
  readonly repoDir: string;
  /** Epoch ms for run ids, timestamps and checkpoint commit dates. Tests inject tests/helpers/clock.ts. */
  readonly clock?: LedgerClock;
  readonly random?: RandomSource;
  /** Defaults to S03's `evt_<uuid>`. */
  readonly newEventId?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly faults?: StorageFaults;
  /**
   * Observe-only phase timings (SPEC-002 "Measurement definition"). createCheckpoint reports gitCommit (the commit
   * objects and the checkpoint ref), blobWrite (the state blob), ledgerAppend and indexUpdate. appendEvent reports
   * ledgerAppend and indexUpdate. Writer acquisition, input validation and fault hooks are not attributed to any
   * phase. Unset: nothing is timed or reported.
   *
   * The same member as the engine's `CheckpointEngineOptions.phaseTimer`; its phase union is the engine's
   * `CheckpointPhase`, spelled out here because Local Storage does not depend on the Checkpoint Engine.
   */
  readonly phaseTimer?:
    | { add(phase: 'changeDetection' | 'scanRedact' | 'hash' | 'blobWrite' | 'gitCommit' | 'ledgerAppend' | 'indexUpdate', ms: number): void }
    | undefined;
}

type StoragePhase = 'blobWrite' | 'gitCommit' | 'ledgerAppend' | 'indexUpdate';

/**
 * Hand one phase's time to the caller's timer. The timer only observes: if `add()` throws (or is not a function), the
 * error is caught and ignored HERE, so the write is exactly what it would have been without a timer.
 */
function reportPhase(timer: NonNullable<LocalBackendOptions['phaseTimer']>, phase: StoragePhase, ms: number): void {
  try {
    timer.add(phase, ms);
  } catch {
    // ignored by design: a phase timer never changes a write's control flow or result
  }
}

interface Writer {
  readonly lock: RunLock;
  head: LedgerHead;
  nextCheckpoint: number;
}

interface DurableRun {
  readonly run: Run;
  readonly events: readonly LedgerEvent[];
  readonly checkpoints: readonly Checkpoint[];
  readonly head: LedgerHead;
  readonly nextCheckpoint: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): StorageError {
  return new StorageError('ERR_INVALID_INPUT', message);
}

function parseRunRecord(text: string, runId: string): Run {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new StorageError('ERR_CORRUPT', `run record of ${runId} is not JSON`, { cause: err });
  }
  if (!isRecord(value)) throw new StorageError('ERR_CORRUPT', `run record of ${runId} is not an object`);
  const { run_id, parent_run_id, forked_from_checkpoint, agent, created_at } = value;
  if (
    run_id !== runId ||
    typeof agent !== 'string' ||
    typeof created_at !== 'string' ||
    !(parent_run_id === null || (typeof parent_run_id === 'string' && RUN_ID_PATTERN.test(parent_run_id))) ||
    !(forked_from_checkpoint === null || (typeof forked_from_checkpoint === 'string' && CHECKPOINT_ID_PATTERN.test(forked_from_checkpoint)))
  ) {
    throw new StorageError('ERR_CORRUPT', `run record of ${runId} is malformed`);
  }
  return { run_id: runId, parent_run_id, forked_from_checkpoint, agent, created_at };
}

function assertCheckpointRef(ref: unknown): asserts ref is CheckpointRef {
  if (!isRecord(ref)) throw invalid('a CheckpointRef is {run_id, checkpoint_id}');
  assertRunId(ref['run_id']);
  assertCheckpointId(ref['checkpoint_id']);
}

export class LocalBackend implements StorageBackend {
  readonly layout: StoreLayout;
  readonly #db: IndexDb;
  readonly #blobs: BlobStore;
  readonly #git: GitRepo;
  readonly #clock: LedgerClock;
  readonly #random: RandomSource;
  readonly #newEventId: (() => string) | undefined;
  readonly #isProcessAlive: ((pid: number) => boolean) | undefined;
  readonly #faults: StorageFaults;
  readonly #phaseTimer: LocalBackendOptions['phaseTimer'];
  readonly #writers = new Map<string, Writer>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(options: LocalBackendOptions, layout: StoreLayout, db: IndexDb, git: GitRepo) {
    this.layout = layout;
    this.#db = db;
    this.#git = git;
    this.#blobs = new BlobStore(layout.objects, layout.tmp);
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#random = options.random ?? cryptoRandom;
    this.#newEventId = options.newEventId;
    this.#isProcessAlive = options.isProcessAlive;
    this.#faults = options.faults ?? {};
    this.#phaseTimer = options.phaseTimer;
  }

  /** Open (creating if needed) the store of the git worktree containing `repoDir`. */
  static async open(options: LocalBackendOptions): Promise<LocalBackend> {
    const git = await GitRepo.open(options.repoDir);
    const layout = storeLayout(git.workTree);
    await ensureLayout(layout);
    const db = IndexDb.open(layout.db);
    return new LocalBackend(options, layout, db, git);
  }

  /** Waits for in-flight writes, releases every run lock this backend holds and closes the index. */
  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#queue;
    if (this.#closed) return;
    this.#closed = true;
    for (const writer of this.#writers.values()) await writer.lock.release().catch(() => undefined);
    this.#writers.clear();
    this.#db.close();
  }

  // ── StorageBackend ──────────────────────────────────────────────────────────────────────────────

  async createRun(input: NewRun): Promise<Run> {
    if (!isRecord(input) || typeof input.agent !== 'string' || input.agent.trim() === '') {
      throw invalid('createRun needs a non-empty agent');
    }
    const parentRunId = input.parent_run_id ?? null;
    const forkedFrom = input.forked_from_checkpoint ?? null;
    if ((parentRunId === null) !== (forkedFrom === null)) {
      throw invalid('parent_run_id and forked_from_checkpoint are set together (a fork) or not at all');
    }
    if (parentRunId !== null) assertRunId(parentRunId, 'parent_run_id');
    if (forkedFrom !== null) assertCheckpointId(forkedFrom, 'forked_from_checkpoint');
    const agent = input.agent;

    return this.#exclusive(async () => {
      if (parentRunId !== null && forkedFrom !== null && this.#db.getCheckpoint(parentRunId, forkedFrom) === undefined) {
        throw new StorageError('ERR_NOT_FOUND', `cannot fork: checkpoint ${parentRunId}/${forkedFrom} does not exist`);
      }
      const now = this.#clock.now();
      const run: Run = {
        run_id: `run_${ulid(now, this.#random)}`,
        parent_run_id: parentRunId,
        forked_from_checkpoint: forkedFrom,
        agent,
        created_at: new Date(now).toISOString(),
      };
      const paths = runPaths(this.layout, run.run_id);
      await ensureDir(paths.dir);
      await writeExclusive(paths.events, '');
      // run.json last: a run directory without it is an abandoned createRun and is ignored.
      await writeExclusive(paths.runFile, `${canonicalJSON(run)}\n`);
      await fsyncDir(paths.dir);
      await fsyncDir(this.layout.runs);
      this.#db.insertRun(run);
      return run;
    });
  }

  /** Every run, forks included, by created_at then run_id (SPEC-015 amendment 5). */
  async listRuns(): Promise<Run[]> {
    this.#assertOpen();
    return this.#db.listRuns();
  }

  async appendEvent(runId: string, event: NewLedgerEvent): Promise<LedgerEvent> {
    assertRunId(runId);
    if (!isRecord(event)) throw invalid('appendEvent needs a draft {type, actor, payload}');
    if (event.type === 'checkpoint.created') {
      throw invalid('checkpoint.created is emitted only by createCheckpoint');
    }
    return this.#withWriter(runId, async (writer, paths) => {
      // ledgerAppend: sealing (hash chain, any payload offload) and the durable log line. indexUpdate: the index rows.
      const timer = this.#phaseTimer;
      const mark = timer === undefined ? 0 : performance.now();
      const sealed = await this.#seal(runId, writer, event);
      await appendEventLine(paths.events, sealed);
      writer.head = { seq: sealed.seq, hash: sealed.hash };
      const appended = timer === undefined ? 0 : performance.now();
      this.#db.transaction(() => {
        this.#db.insertEvent(sealed);
        if (sealed.payload_ref !== null) this.#db.insertBlob(sealed.payload_ref);
      });
      if (timer !== undefined) {
        reportPhase(timer, 'ledgerAppend', appended - mark);
        reportPhase(timer, 'indexUpdate', performance.now() - appended);
      }
      return sealed;
    });
  }

  async getEvents(runId: string, range: { fromSeq: number; toSeq: number }): Promise<LedgerEvent[]> {
    assertRunId(runId);
    if (!isRecord(range) || !Number.isInteger(range.fromSeq) || !Number.isInteger(range.toSeq)) {
      throw invalid('getEvents range is {fromSeq, toSeq} (integers, inclusive)');
    }
    this.#assertOpen();
    return this.#db.getEvents(runId, range.fromSeq, range.toSeq);
  }

  async putBlob(data: Uint8Array | Readable): Promise<BlobRef> {
    this.#assertOpen();
    const ref = await this.#blobs.put(data);
    this.#db.insertBlob(ref);
    return ref;
  }

  async getBlob(ref: BlobRef): Promise<Readable> {
    this.#assertOpen();
    return this.#blobs.get(ref);
  }

  async createCheckpoint(input: NewCheckpoint): Promise<Checkpoint> {
    if (!isRecord(input)) throw invalid('createCheckpoint needs a NewCheckpoint');
    const runId = input.run_id;
    assertRunId(runId);
    const parentId = input.parent_checkpoint_id;
    if (parentId !== null) assertCheckpointId(parentId, 'parent_checkpoint_id');
    const label = input.label ?? null;
    if (label !== null && (typeof label !== 'string' || label === '')) throw invalid('label is a non-empty string or null');
    if (typeof input.stagingDir !== 'string' || input.stagingDir === '') throw invalid('stagingDir is required');
    // Shape and path syntax now; the fit against stagingDir and the parent tree is checked by commitTree.
    const changes = input.changes === undefined ? undefined : checkWorkspaceChanges(input.changes);
    // Validate the caller's state inputs before taking the writer lock.
    const probe = validateAgentState({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      run_id: runId,
      checkpoint_id: 'c_1',
      ledger_seq: 1,
      workspace_commit: '0'.repeat(40),
      pending_intent: input.pending_intent,
      usage: input.usage,
    });
    if (!probe.ok) throw invalid(`invalid checkpoint state inputs: ${probe.errors.join('; ')}`);
    const usage = { input_tokens: input.usage.input_tokens, output_tokens: input.usage.output_tokens };

    return this.#withWriter(runId, async (writer, paths) => {
      const run = this.#db.getRun(runId);
      if (run === undefined) throw new StorageError('ERR_NOT_FOUND', `run ${runId} is not indexed`);
      let parentCommit: string | null = null;
      if (parentId !== null) {
        const parent = this.#db.getCheckpoint(runId, parentId);
        if (parent === undefined) throw new StorageError('ERR_NOT_FOUND', `parent checkpoint ${runId}/${parentId} does not exist`);
        parentCommit = parent.workspace_commit;
      } else if (run.parent_run_id !== null && run.forked_from_checkpoint !== null) {
        parentCommit = this.#db.getCheckpoint(run.parent_run_id, run.forked_from_checkpoint)?.workspace_commit ?? null;
      }

      const checkpointId = `c_${writer.nextCheckpoint}`;
      const at: CheckpointRef = { run_id: runId, checkpoint_id: checkpointId };
      const seq = writer.head.seq + 1;
      const now = this.#clock.now();

      // Phase timing (SPEC-002): gitCommit = steps 1 and 3, blobWrite = step 2, ledgerAppend = step 4 (sealing and the
      // log line), indexUpdate = step 5. Validation and the fault hooks are not attributed. Without a timer nothing is
      // timed; the intervals never overlap. Reported once, after the index rows are written.
      const timer = this.#phaseTimer;
      let gitCommitMs = 0;
      let mark = timer === undefined ? 0 : performance.now();

      // 1. Workspace objects from the sanitized staging tree (not reachable from any ref yet). With a
      //    parent commit and a delta, built on the parent's tree from the written files only.
      const { commit } = await this.#git.commitTree(input.stagingDir, {
        parent: parentCommit,
        changes,
        message: `ckpt ${runId}/${checkpointId}`,
        timeMs: now,
        tmpDir: this.layout.tmp,
      });
      if (timer !== undefined) {
        const t = performance.now();
        gitCommitMs += t - mark;
        mark = t;
      }

      // 2. CAS: the deterministic Agent State Object.
      const state: AgentStateObject = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        run_id: runId,
        checkpoint_id: checkpointId,
        ledger_seq: seq,
        workspace_commit: commit,
        pending_intent: input.pending_intent,
        usage,
      };
      const stateRef = await this.#blobs.put(Buffer.from(canonicalJSON(state), 'utf8'));
      let blobWriteMs = 0;
      if (timer !== undefined) {
        const t = performance.now();
        blobWriteMs = t - mark;
        mark = t;
      }

      // 3. Git ref.
      await this.#git.updateRef(checkpointRefName(runId, checkpointId), commit);
      if (timer !== undefined) gitCommitMs += performance.now() - mark;
      await this.#faults.afterRefWrite?.(at);

      // 4. Ledger event; its payload is the full checkpoint record, so reindex can rebuild the row.
      const checkpoint: Checkpoint = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        checkpoint_id: checkpointId,
        run_id: runId,
        parent_checkpoint_id: parentId,
        label,
        state_blob: stateRef,
        state_hash: stateRef.sha256,
        workspace_commit: commit,
        ledger_seq: seq,
        usage,
        created_at: new Date(now).toISOString(),
      };
      const valid = validateCheckpoint(checkpoint);
      if (!valid.ok) throw invalid(`checkpoint record is invalid: ${valid.errors.join('; ')}`);
      if (timer !== undefined) mark = performance.now();
      const event = await this.#seal(runId, writer, {
        type: 'checkpoint.created',
        actor: 'runtime',
        payload: checkpoint as unknown as JsonPayload,
      });
      if (event.seq !== seq || event.payload === null) {
        throw new StorageError('ERR_CORRUPT', `checkpoint.created sealed at seq ${event.seq}, expected ${seq} inline`);
      }
      await appendEventLine(paths.events, event);
      writer.head = { seq: event.seq, hash: event.hash };
      writer.nextCheckpoint += 1;
      const ledgerAppendMs = timer === undefined ? 0 : performance.now() - mark;
      await this.#faults.afterCheckpointEvent?.(at);

      // 5. Index rows, last and atomic.
      if (timer !== undefined) mark = performance.now();
      this.#db.transaction(() => {
        this.#db.insertEvent(event);
        this.#db.insertBlob(stateRef);
        this.#db.insertCheckpoint(checkpoint);
      });
      if (timer !== undefined) {
        reportPhase(timer, 'gitCommit', gitCommitMs);
        reportPhase(timer, 'blobWrite', blobWriteMs);
        reportPhase(timer, 'ledgerAppend', ledgerAppendMs);
        reportPhase(timer, 'indexUpdate', performance.now() - mark);
      }
      return checkpoint;
    });
  }

  async getCheckpoint(id: CheckpointRef): Promise<Checkpoint> {
    assertCheckpointRef(id);
    this.#assertOpen();
    const checkpoint = this.#db.getCheckpoint(id.run_id, id.checkpoint_id);
    if (checkpoint === undefined) throw new StorageError('ERR_NOT_FOUND', `checkpoint ${id.run_id}/${id.checkpoint_id} does not exist`);
    return checkpoint;
  }

  async listCheckpoints(runId: string): Promise<Checkpoint[]> {
    assertRunId(runId);
    this.#assertOpen();
    return this.#db.listCheckpoints(runId);
  }

  async getState(id: CheckpointRef): Promise<AgentStateObject> {
    const checkpoint = await this.getCheckpoint(id);
    const bytes = await this.#blobs.read(checkpoint.state_blob);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      throw new StorageError('ERR_CORRUPT', `state blob of ${id.run_id}/${id.checkpoint_id} is not JSON`, { cause: err });
    }
    const valid = validateAgentState(parsed);
    if (!valid.ok) throw new StorageError('ERR_CORRUPT', `state blob of ${id.run_id}/${id.checkpoint_id}: ${valid.errors.join('; ')}`);
    if (valid.value.run_id !== checkpoint.run_id || valid.value.checkpoint_id !== checkpoint.checkpoint_id) {
      throw new StorageError('ERR_CORRUPT', `state blob of ${id.run_id}/${id.checkpoint_id} belongs to another checkpoint`);
    }
    return valid.value;
  }

  async putProjection(projection: SemanticProjection): Promise<BlobRef> {
    const valid = validateSemanticProjection(projection);
    if (!valid.ok) throw invalid(`invalid projection: ${valid.errors.join('; ')}`);
    const bytes = Buffer.from(canonicalJSON(projection), 'utf8');
    const sha256 = sha256Hex(bytes);

    return this.#exclusive(async () => {
      const { checkpointId, input } = projection;
      const checkpoint = this.#db.findCheckpointByState(checkpointId, input.stateHash);
      if (checkpoint === undefined) {
        throw new StorageError('ERR_NOT_FOUND', `no checkpoint ${checkpointId} has state hash ${input.stateHash}`);
      }
      if (checkpoint.workspace_commit !== input.workspaceCommit) {
        throw invalid(`projection ${projection.id} names workspace commit ${input.workspaceCommit}, but ${checkpoint.run_id}/${checkpointId} is ${checkpoint.workspace_commit}`);
      }
      const existing = this.#db.getProjectionRef(projection.id);
      if (existing !== undefined) {
        if (existing.sha256 === sha256) return existing;
        throw invalid(`projection ${projection.id} is already stored with different content; projections are never overwritten`);
      }
      // CAS first (durable), then the index rows, in one transaction.
      const ref = await this.#blobs.put(bytes);
      this.#db.transaction(() => {
        this.#db.insertBlob(ref);
        this.#db.insertProjection(projectionEntry(projection, checkpoint, ref));
      });
      return ref;
    });
  }

  async listProjections(query: ProjectionQuery): Promise<SemanticProjection[]> {
    this.#assertOpen();
    const indexed = this.#projectionsFor(query);
    const out: SemanticProjection[] = [];
    for (const entry of indexed) out.push(await this.#readProjection(entry));
    return out;
  }

  async listClaims(query: ProjectionQuery): Promise<SemanticClaim[]> {
    return (await this.listProjections(query)).flatMap((projection) => projection.claims);
  }

  /**
   * Storage half of a fork: a new run whose lineage points at `id`. Emitting `agent.forked` and
   * creating the fork's first checkpoint are the Checkpoint Engine's job.
   */
  async fork(id: CheckpointRef): Promise<Run> {
    const checkpoint = await this.getCheckpoint(id);
    const source = this.#db.getRun(checkpoint.run_id);
    if (source === undefined) throw new StorageError('ERR_NOT_FOUND', `run ${checkpoint.run_id} is not indexed`);
    return this.createRun({ agent: source.agent, parent_run_id: checkpoint.run_id, forked_from_checkpoint: checkpoint.checkpoint_id });
  }

  /** Rebuild checkpoint.db from runs/, CAS and refs, projections and claims included. Takes every run's lock while it reads. */
  async reindex(): Promise<ReindexCounts> {
    return this.#exclusive(async () => {
      const taken: RunLock[] = [];
      try {
        const loaded: DurableRun[] = [];
        for (const runId of await this.#durableRunIds()) {
          const paths = runPaths(this.layout, runId);
          const run = await this.#readRun(paths, runId);
          if (run === undefined) continue;
          if (!this.#writers.has(runId)) {
            taken.push(await RunLock.acquire(this.layout.lock, runId, { isProcessAlive: this.#isProcessAlive }));
          }
          loaded.push(await this.#loadDurableRun(run, paths));
        }
        const blobs = await this.#blobs.list();
        const projections = await this.#durableProjections(loaded, blobs);

        this.#db.transaction(() => {
          this.#db.clearAll();
          for (const durable of loaded) {
            this.#db.insertRun(durable.run);
            for (const event of durable.events) this.#db.insertEvent(event);
            for (const checkpoint of durable.checkpoints) this.#db.insertCheckpoint(checkpoint);
          }
          for (const blob of blobs) this.#db.insertBlob(blob);
          for (const entry of projections) this.#db.insertProjection(entry);
        });

        for (const durable of loaded) {
          const writer = this.#writers.get(durable.run.run_id);
          if (writer !== undefined) {
            writer.head = durable.head;
            writer.nextCheckpoint = durable.nextCheckpoint;
          }
        }
        return {
          runs: loaded.length,
          checkpoints: loaded.reduce((sum, durable) => sum + durable.checkpoints.length, 0),
          events: loaded.reduce((sum, durable) => sum + durable.events.length, 0),
          projections: projections.length,
          claims: projections.reduce((sum, entry) => sum + entry.claims.length, 0),
        };
      } finally {
        for (const lock of taken) await lock.release();
      }
    });
  }

  // ── storage utilities beyond the contract ──────────────────────────────────────────────────────

  /** Change detection over `root` with this run's `path → size, mtime, inode, sha256` cache in checkpoint.db. */
  createChangeDetector(runId: string, root: string, options: { fs?: ChangeDetectionFs; nowNs?: () => bigint } = {}): ChangeDetector {
    assertRunId(runId);
    this.#assertOpen();
    return new ChangeDetector({ root, cache: this.#db.fileCache(runId), fs: options.fs, nowNs: options.nowNs });
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────

  #assertOpen(): void {
    if (this.#closed) throw new StorageError('ERR_CLOSED', 'this LocalBackend is closed');
  }

  /** Serialise mutations within this backend (one at a time). */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.#assertOpen();
      return fn();
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #withWriter<T>(runId: string, fn: (writer: Writer, paths: RunPaths) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      const paths = runPaths(this.layout, runId);
      const writer = await this.#writer(runId, paths);
      try {
        return await fn(writer, paths);
      } catch (err) {
        // Anything may have been half-written: drop the writer so the next write recovers from disk.
        if (this.#writers.get(runId) === writer) this.#writers.delete(runId);
        await writer.lock.release().catch(() => undefined);
        throw err;
      }
    });
  }

  async #writer(runId: string, paths: RunPaths): Promise<Writer> {
    const existing = this.#writers.get(runId);
    if (existing !== undefined) return existing;

    const run = await this.#readRun(paths, runId);
    if (run === undefined) throw new StorageError('ERR_NOT_FOUND', `run ${runId} does not exist`);
    const lock = await RunLock.acquire(this.layout.lock, runId, { isProcessAlive: this.#isProcessAlive });
    try {
      const durable = await this.#loadDurableRun(run, paths);
      const indexedSeq = this.#db.maxEventSeq(runId);
      if (indexedSeq > durable.head.seq) {
        throw new StorageError(
          'ERR_CORRUPT',
          `checkpoint.db indexes ${runId} up to seq ${indexedSeq} but its ledger ends at seq ${durable.head.seq}; run reindex`,
        );
      }
      // Roll the index forward to the durable ledger (e.g. after a crash before the index rows).
      this.#db.transaction(() => {
        this.#db.insertRun(run, { ignoreExisting: true });
        for (const event of durable.events) {
          if (event.seq <= indexedSeq) continue;
          this.#db.insertEvent(event);
          if (event.payload_ref !== null) this.#db.insertBlob(event.payload_ref);
        }
        for (const checkpoint of durable.checkpoints) {
          if (checkpoint.ledger_seq <= indexedSeq) continue;
          this.#db.insertCheckpoint(checkpoint);
          this.#db.insertBlob(checkpoint.state_blob);
        }
      });
      const writer: Writer = { lock, head: durable.head, nextCheckpoint: durable.nextCheckpoint };
      this.#writers.set(runId, writer);
      return writer;
    } catch (err) {
      await lock.release();
      throw err;
    }
  }

  /** The indexed projections a query names, in listing order. */
  #projectionsFor(query: ProjectionQuery): IndexedProjection[] {
    if (!isRecord(query)) throw invalid('a projection query is {runId, checkpointId} or {runId, lineage: true}');
    assertRunId(query.runId, 'runId');
    if (query.lineage === true) {
      return this.#lineageCheckpoints(query.runId).flatMap((checkpoint) => this.#db.listProjections(checkpoint.run_id, checkpoint.checkpoint_id));
    }
    if (query.lineage !== undefined) throw invalid('lineage is true, or absent for a single-checkpoint query');
    const { runId, checkpointId } = query;
    assertCheckpointId(checkpointId, 'checkpointId');
    if (this.#db.getCheckpoint(runId, checkpointId) === undefined) {
      throw new StorageError('ERR_NOT_FOUND', `checkpoint ${runId}/${checkpointId} does not exist`);
    }
    return this.#db.listProjections(runId, checkpointId);
  }

  /**
   * A run's lineage, oldest first: for each fork parent (outermost first), the checkpoint the child was forked from
   * and its parent_checkpoint_id ancestors; then every checkpoint of the run itself. Each segment is in checkpoint
   * order.
   */
  #lineageCheckpoints(runId: string): Checkpoint[] {
    const run = this.#db.getRun(runId);
    if (run === undefined) throw new StorageError('ERR_NOT_FOUND', `run ${runId} does not exist`);
    const segments: Checkpoint[][] = [this.#db.listCheckpoints(runId)];
    const visited = new Set<string>([runId]);
    let child: Run = run;
    while (child.parent_run_id !== null && child.forked_from_checkpoint !== null && !visited.has(child.parent_run_id)) {
      const parentRunId = child.parent_run_id;
      visited.add(parentRunId);
      const chain: Checkpoint[] = [];
      const seen = new Set<string>();
      let id: string | null = child.forked_from_checkpoint;
      while (id !== null && !seen.has(id)) {
        seen.add(id);
        const checkpoint = this.#db.getCheckpoint(parentRunId, id);
        if (checkpoint === undefined) break;
        chain.push(checkpoint);
        id = checkpoint.parent_checkpoint_id;
      }
      segments.unshift(chain.sort((a, b) => checkpointNumber(a.checkpoint_id) - checkpointNumber(b.checkpoint_id)));
      const parent = this.#db.getRun(parentRunId);
      if (parent === undefined) break;
      child = parent;
    }
    return segments.flat();
  }

  async #readProjection(entry: IndexedProjection): Promise<SemanticProjection> {
    let bytes: Buffer;
    try {
      bytes = await this.#blobs.read(entry.ref);
    } catch (err) {
      if (isStorageError(err, 'ERR_NOT_FOUND')) {
        throw new StorageError('ERR_CORRUPT', `projection ${entry.projection_id} is indexed but blob ${entry.ref.sha256} is missing; run reindex`, { cause: err });
      }
      throw err;
    }
    const projection = parseProjection(bytes);
    if (projection === undefined || projection.id !== entry.projection_id) {
      throw new StorageError('ERR_CORRUPT', `blob ${entry.ref.sha256} indexed for projection ${entry.projection_id} does not hold it; run reindex`);
    }
    return projection;
  }

  /**
   * The projection index rows reindex rebuilds from CAS: every blob that is a valid SemanticProjection of a durable
   * checkpoint (same checkpoint id, state hash and workspace commit). Blobs are visited in address order, and the
   * first blob for a projection id wins (putProjection never stores two different blobs under one id). A damaged
   * candidate blob is skipped rather than failing the whole rebuild.
   */
  async #durableProjections(loaded: readonly DurableRun[], blobs: readonly BlobRef[]): Promise<ProjectionIndexEntry[]> {
    const checkpoints = new Map<string, Checkpoint>();
    for (const durable of loaded) {
      for (const checkpoint of durable.checkpoints) checkpoints.set(stateKey(checkpoint.checkpoint_id, checkpoint.state_hash), checkpoint);
    }
    const entries: ProjectionIndexEntry[] = [];
    const ids = new Set<string>();
    for (const ref of blobs) {
      if (ref.size < PROJECTION_BLOB_PREFIX.byteLength) continue;
      if (!(await this.#blobs.readPrefix(ref, PROJECTION_BLOB_PREFIX.byteLength)).equals(PROJECTION_BLOB_PREFIX)) continue;
      let bytes: Buffer;
      try {
        bytes = await this.#blobs.read(ref);
      } catch (err) {
        if (isStorageError(err, 'ERR_CORRUPT')) continue;
        throw err;
      }
      const projection = parseProjection(bytes);
      if (projection === undefined || ids.has(projection.id)) continue;
      const checkpoint = checkpoints.get(stateKey(projection.checkpointId, projection.input.stateHash));
      if (checkpoint === undefined || checkpoint.workspace_commit !== projection.input.workspaceCommit) continue;
      ids.add(projection.id);
      entries.push(projectionEntry(projection, checkpoint, ref));
    }
    return entries;
  }

  #seal(runId: string, writer: Writer, draft: NewLedgerEvent): Promise<LedgerEvent> {
    const ledger = new ExecutionLedger({
      run_id: runId,
      blobs: { putBlob: (bytes) => this.#blobs.put(bytes) },
      clock: this.#clock,
      head: writer.head,
      newEventId: this.#newEventId,
    });
    // Spread the draft so the ledger sees (and rejects) any member other than type, actor, payload.
    return ledger.append({ run_id: runId, ...draft } as LedgerEventDraft);
  }

  async #durableRunIds(): Promise<string[]> {
    const entries = await readdir(this.layout.runs, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async #readRun(paths: RunPaths, runId: string): Promise<Run | undefined> {
    try {
      return parseRunRecord(await readFile(paths.runFile, 'utf8'), runId);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return undefined;
      throw err;
    }
  }

  /** Read a run's durable state. The caller must hold the run's lock (a torn ledger tail is truncated). */
  async #loadDurableRun(run: Run, paths: RunPaths): Promise<DurableRun> {
    const log = await readEventLog(paths.events, run.run_id);
    if (log.tornBytes > 0) await truncateEventLog(paths.events, log.validBytes);
    const chain = verifyChain(log.events);
    if (!chain.ok) {
      throw new StorageError('ERR_CORRUPT', `ledger of ${run.run_id} is broken at seq ${chain.brokenAtSeq}: ${chain.reason}`);
    }

    const refs = await this.#git.listRefs(`refs/checkpoints/${run.run_id}/`);
    const checkpoints: Checkpoint[] = [];
    let highest = 0;
    for (const event of log.events) {
      if (event.type !== 'checkpoint.created') continue;
      const valid = validateCheckpoint(event.payload);
      if (!valid.ok) continue;
      const checkpoint = valid.value;
      if (checkpoint.run_id !== run.run_id || checkpoint.ledger_seq !== event.seq) continue;
      highest = Math.max(highest, checkpointNumber(checkpoint.checkpoint_id));
      if (refs.get(checkpointRefName(run.run_id, checkpoint.checkpoint_id)) !== checkpoint.workspace_commit) continue;
      if (!(await this.#blobs.has(checkpoint.state_blob))) continue;
      checkpoints.push(checkpoint);
    }

    const last = log.events.at(-1);
    return {
      run,
      events: log.events,
      checkpoints,
      head: last === undefined ? GENESIS_HEAD : { seq: last.seq, hash: last.hash },
      nextCheckpoint: highest + 1,
    };
  }
}
