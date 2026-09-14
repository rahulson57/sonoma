/**
 * Shared harness for the SPEC-014 benchmark scenarios (bench/scenarios/*.bench.ts).
 *
 * WHAT IS MEASURED. Every scenario drives the REAL Checkpoint Engine over the REAL LocalBackend, Redaction and
 * ledger (SPEC-014 "Must never": no stub, no mock). The engine's backend is `ProbedBackend`, a pure delegating
 * StorageBackend that forwards every call unchanged and only reads the clock; LocalBackend's own `StorageFaults`
 * seams add two more clock reads inside `createCheckpoint`. Nothing on the checkpoint path behaves differently.
 *
 * PHASES: NULL, NEVER 0 (operator ruling MSG-3495, DEC-049(1), DEC-050). No per-phase timing hook exists in
 * src/engine or src/storage yet (the approved `phaseTimer` follow-up waits on TASK-011). From outside, a checkpoint
 * splits into exactly 4 honestly measurable buckets:
 *
 *   checkpoint() call ── createCheckpoint() call ── afterRefWrite ── afterCheckpointEvent ── createCheckpoint() return ── ACK
 *        │ beforeStorage (merged) │ storageToRef (merged)  │ ledgerAppend           │ indexUpdate               │ afterStorage
 *
 * - `ledgerAppend`  = afterRefWrite → afterCheckpointEvent: seal + durable append of checkpoint.created. One phase.
 * - `indexUpdate`   = afterCheckpointEvent → createCheckpoint returns: the index transaction. One phase.
 * - `beforeStorage` = snapshot work (changeDetection + scanRedact + hash + staging writes) and `storageToRef`
 *   (writer lock, git objects/tree/commit, state-blob CAS write, ref write) each MERGE several SPEC-002 phases.
 *   They are reported only under `unattributedP95Ms`, never under a phase key: a merged span under a documented
 *   key would launder a 4-bucket measurement as a 7-phase one (rejected in MSG-3495).
 * So `changeDetection`, `scanRedact`, `hash`, `blobWrite` and `gitCommit` are null for checkpoint scenarios, and
 * bench:check reports every budgeted scenario NOT MEASURED until the hook lands. When any other ledger append
 * happens inside the window (e.g. a `workspace.file_skipped`), its ledger and index work sits outside the two
 * seams, so `ledgerAppend` and `indexUpdate` are null for that sample too.
 *
 * WHEN THE HOOK LANDS: pass `phaseTimer` through `openStore()` into CheckpointEngineOptions and fill the other
 * phases in `checkpointPhases()`. That is the only place phase values are decided.
 *
 * WORKSPACES live in fixture repositories from tests/helpers/tmpRepo.ts (`tmpGitRepo()`, SPEC-014 "Accepts"),
 * created under `<os tmpdir>/ckpt-bench.noindex/` so Spotlight does not index them (DEC-047(4)). Each scenario
 * removes its own repository when its measured run ends, and on process exit.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { CheckpointEngine } from '../../../src/engine/index.js';
import type { LedgerEventDraft } from '../../../src/model/types.js';
import { LocalBackend, RACY_WINDOW_NS, STORE_DIR_NAME, type StorageBackend } from '../../../src/storage/index.js';
import { secretCorpus } from '../../../tests/helpers/fakeSecrets.js';
import { seededRng } from '../../../tests/helpers/prng.js';
import { TMP_REPO_PREFIX, tmpGitRepo, type TmpGitRepo } from '../../../tests/helpers/tmpRepo.js';
import type { CheckpointSample, PhaseDurations, PhaseRecorder } from '../../phases.js';
import { percentile } from '../../phases.js';

const execFileAsync = promisify(execFile);

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;

// ── measurement ──────────────────────────────────────────────────────────────────────────────────────

type MarkName = 'createStart' | 'refWritten' | 'eventDurable' | 'createEnd' | 'firstAppend';

/** Clock readings (performance.now() ms) and call counts inside one measured window. */
interface Window {
  marks: Partial<Record<MarkName, number>>;
  creates: number;
  appends: number;
  /** Backend calls other than appendEvent/createCheckpoint before the first appendEvent. */
  callsBeforeFirstAppend: number;
}

/** Collects marks while a window is open; outside a window every mark is ignored. */
export class Probe {
  #window: Window | null = null;

  open(): Window {
    if (this.#window !== null) throw new Error('harness: a measured window is already open');
    this.#window = { marks: {}, creates: 0, appends: 0, callsBeforeFirstAppend: 0 };
    return this.#window;
  }

  close(): void {
    this.#window = null;
  }

  mark(name: MarkName): void {
    const w = this.#window;
    if (w === null) return;
    if (w.marks[name] !== undefined && name !== 'createEnd') throw new Error(`harness: mark ${name} fired twice in one window`);
    w.marks[name] = performance.now();
  }

  onCreate(): void {
    if (this.#window === null) return;
    this.#window.creates += 1;
    this.mark('createStart');
  }

  onAppend(): void {
    const w = this.#window;
    if (w === null) return;
    if (w.appends === 0) this.mark('firstAppend');
    w.appends += 1;
  }

  onOther(): void {
    const w = this.#window;
    if (w !== null && w.appends === 0) w.callsBeforeFirstAppend += 1;
  }
}

type SB = StorageBackend;

/** A pure delegating StorageBackend: every call is forwarded unchanged; the probe only reads the clock. */
export class ProbedBackend implements StorageBackend {
  readonly #inner: LocalBackend;
  readonly #probe: Probe;

  constructor(inner: LocalBackend, probe: Probe) {
    this.#inner = inner;
    this.#probe = probe;
  }

  createRun(...a: Parameters<SB['createRun']>): ReturnType<SB['createRun']> {
    this.#probe.onOther();
    return this.#inner.createRun(...a);
  }
  listRuns(...a: Parameters<SB['listRuns']>): ReturnType<SB['listRuns']> {
    this.#probe.onOther();
    return this.#inner.listRuns(...a);
  }
  appendEvent(...a: Parameters<SB['appendEvent']>): ReturnType<SB['appendEvent']> {
    this.#probe.onAppend();
    return this.#inner.appendEvent(...a);
  }
  getEvents(...a: Parameters<SB['getEvents']>): ReturnType<SB['getEvents']> {
    this.#probe.onOther();
    return this.#inner.getEvents(...a);
  }
  putBlob(...a: Parameters<SB['putBlob']>): ReturnType<SB['putBlob']> {
    this.#probe.onOther();
    return this.#inner.putBlob(...a);
  }
  getBlob(...a: Parameters<SB['getBlob']>): ReturnType<SB['getBlob']> {
    this.#probe.onOther();
    return this.#inner.getBlob(...a);
  }
  createCheckpoint(...a: Parameters<SB['createCheckpoint']>): ReturnType<SB['createCheckpoint']> {
    this.#probe.onCreate();
    return this.#inner.createCheckpoint(...a).finally(() => this.#probe.mark('createEnd'));
  }
  getCheckpoint(...a: Parameters<SB['getCheckpoint']>): ReturnType<SB['getCheckpoint']> {
    this.#probe.onOther();
    return this.#inner.getCheckpoint(...a);
  }
  listCheckpoints(...a: Parameters<SB['listCheckpoints']>): ReturnType<SB['listCheckpoints']> {
    this.#probe.onOther();
    return this.#inner.listCheckpoints(...a);
  }
  getState(...a: Parameters<SB['getState']>): ReturnType<SB['getState']> {
    this.#probe.onOther();
    return this.#inner.getState(...a);
  }
  putProjection(...a: Parameters<SB['putProjection']>): ReturnType<SB['putProjection']> {
    this.#probe.onOther();
    return this.#inner.putProjection(...a);
  }
  listProjections(...a: Parameters<SB['listProjections']>): ReturnType<SB['listProjections']> {
    this.#probe.onOther();
    return this.#inner.listProjections(...a);
  }
  listClaims(...a: Parameters<SB['listClaims']>): ReturnType<SB['listClaims']> {
    this.#probe.onOther();
    return this.#inner.listClaims(...a);
  }
  fork(...a: Parameters<SB['fork']>): ReturnType<SB['fork']> {
    this.#probe.onOther();
    return this.#inner.fork(...a);
  }
  reindex(...a: Parameters<SB['reindex']>): ReturnType<SB['reindex']> {
    this.#probe.onOther();
    return this.#inner.reindex(...a);
  }
}

/** One measured sample: SPEC-002 fields plus merged spans that are explicitly NOT phases. */
export interface MeasuredSample extends CheckpointSample {
  unattributed: Record<string, number>;
}

const unmeasured = (): PhaseDurations => ({
  changeDetection: null,
  scanRedact: null,
  hash: null,
  blobWrite: null,
  gitCommit: null,
  ledgerAppend: null,
  indexUpdate: null,
});

function need(w: Window, name: MarkName): number {
  const value = w.marks[name];
  if (value === undefined) throw new Error(`harness: mark ${name} did not fire inside the measured window`);
  return value;
}

/**
 * The only place phase values are decided. Today: ledgerAppend and indexUpdate from the StorageFaults seams, when
 * the window holds exactly one createCheckpoint and no other ledger append; every other phase null.
 */
function checkpointPhases(w: Window): PhaseDurations {
  if (w.creates !== 1) throw new Error(`harness: expected exactly 1 createCheckpoint in the measured window, saw ${w.creates}`);
  const phases = unmeasured();
  const refWritten = need(w, 'refWritten');
  const eventDurable = need(w, 'eventDurable');
  const createEnd = need(w, 'createEnd');
  if (w.appends === 0) {
    phases.ledgerAppend = eventDurable - refWritten;
    phases.indexUpdate = createEnd - eventDurable;
  }
  return phases;
}

export interface Store {
  readonly repoDir: string;
  readonly backend: LocalBackend;
  readonly engine: CheckpointEngine;
  readonly probe: Probe;
  close(): Promise<void>;
}

/** The real LocalBackend (with StorageFaults clock marks) and the real engine over the delegating probe. */
export async function openStore(repoDir: string, tmpDir: string): Promise<Store> {
  const probe = new Probe();
  const backend = await LocalBackend.open({
    repoDir,
    faults: {
      afterRefWrite: () => probe.mark('refWritten'),
      afterCheckpointEvent: () => probe.mark('eventDurable'),
    },
  });
  try {
    const engine = await CheckpointEngine.open({ backend: new ProbedBackend(backend, probe), repoDir, tmpDir });
    return { repoDir, backend, engine, probe, close: () => backend.close() };
  } catch (err) {
    await backend.close();
    throw err;
  }
}

/** checkpoint() call to ACK. */
export async function measureCheckpoint(store: Store, runId: string): Promise<MeasuredSample> {
  const w = store.probe.open();
  try {
    const start = performance.now();
    await store.engine.checkpoint(runId);
    const ack = performance.now();
    const phases = checkpointPhases(w);
    const createStart = need(w, 'createStart');
    return {
      totalMs: ack - start,
      phases,
      unattributed: {
        beforeStorage: createStart - start,
        storageToRef: need(w, 'refWritten') - createStart,
        afterStorage: ack - need(w, 'createEnd'),
      },
    };
  } finally {
    store.probe.close();
  }
}

/**
 * record() of one observation, then checkpoint(): the automatic checkpoint boundary that carries a tool output.
 * `scanRedact` = record() call → its appendEvent call: sanitizePayload plus O(1) validation and queueing, with no
 * other backend call in between (else null). The observation's own append (ledger + CAS offload + index) is a
 * ledger append outside the seams, so ledgerAppend and indexUpdate are null.
 */
export async function measureRecordThenCheckpoint(store: Store, draft: LedgerEventDraft): Promise<MeasuredSample> {
  const w = store.probe.open();
  try {
    const start = performance.now();
    await store.engine.record([draft]);
    const recorded = performance.now();
    await store.engine.checkpoint(draft.run_id);
    const ack = performance.now();
    const phases = checkpointPhases(w);
    const firstAppend = need(w, 'firstAppend');
    if (w.callsBeforeFirstAppend === 0) phases.scanRedact = firstAppend - start;
    return {
      totalMs: ack - start,
      phases,
      unattributed: {
        observationAppend: recorded - firstAppend,
        checkpoint: ack - recorded,
      },
    };
  } finally {
    store.probe.close();
  }
}

// ── scenario plumbing ────────────────────────────────────────────────────────────────────────────────

export interface ScenarioSpec<S> {
  /** Untimed, once, before warmup: build the workspace and the store. */
  prepare(ws: BenchRepo): Promise<S>;
  /** One iteration: untimed changes first, then exactly one measured sample. */
  iterate(state: S, iteration: number): Promise<MeasuredSample>;
  /** Untimed; best effort. */
  close?(state: S): Promise<void>;
}

type Hook = (task: object, mode: string) => void | Promise<void>;

/**
 * Wires a scenario into vitest `bench()`: the recorder's hooks plus one-time preparation (tinybench awaits
 * `setup`) and synchronous removal of the workspace when the measured run ends (tinybench does not await
 * `teardown`). Also attaches `unattributedP95Ms`, the p95 of each merged span, next to the BenchResult fields.
 */
export function scenarioBench<S>(scenario: string, recorder: PhaseRecorder, spec: ScenarioSpec<S>) {
  let prepared: Promise<{ ws: BenchRepo; state: S }> | undefined;
  let ws: BenchRepo | undefined;
  let iteration = 0;
  let spans: Array<Record<string, number>> = [];

  const setup: Hook = async (task, mode) => {
    recorder.options.setup(task, mode);
    spans = [];
    prepared ??= (async () => {
      ws = await benchRepo(scenario);
      return { ws, state: await spec.prepare(ws) };
    })();
    await prepared;
  };

  const teardown: Hook = (task, mode) => {
    if (mode !== 'run') return;
    try {
      recorder.options.teardown(task, mode);
      const keys = Object.keys(spans[0] ?? {});
      const target = task as { result?: Record<string, unknown> };
      target.result = {
        ...(target.result ?? {}),
        unattributedP95Ms: Object.fromEntries(keys.map((key) => [key, percentile(spans.map((s) => s[key] ?? 0), 95)])),
        unattributedNote: 'merged spans, NOT SPEC-002 phases; see bench/scenarios/support/harness.ts',
      };
    } finally {
      ws?.removeSync();
    }
  };

  const run = async (): Promise<void> => {
    if (prepared === undefined) throw new Error(`${scenario}: setup did not run`);
    const { state } = await prepared;
    const sample = await spec.iterate(state, iteration++);
    recorder.record(sample);
    spans.push(sample.unattributed);
  };

  return { run, options: { setup, teardown } };
}

// ── workspaces ───────────────────────────────────────────────────────────────────────────────────────

export interface BenchRepo {
  readonly repo: TmpGitRepo;
  readonly dir: string;
  /** The `.noindex` directory holding the repository; engine staging directories go here too. */
  readonly base: string;
  removeSync(): void;
}

/** A tmpGitRepo() fixture repository under `<os tmpdir>/ckpt-bench.noindex/`. */
export async function benchRepo(scenario: string): Promise<BenchRepo> {
  const base = path.join(realpathSync(os.tmpdir()), 'ckpt-bench.noindex');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  // tmpGitRepo() places the repository under os.tmpdir(), which it reads synchronously on entry (before its first
  // await). Point TMPDIR at the .noindex base for exactly that call; the result is checked below.
  const saved = process.env['TMPDIR'];
  process.env['TMPDIR'] = base;
  let pending: Promise<TmpGitRepo>;
  try {
    pending = tmpGitRepo({ files: { 'README.md': `ckpt benchmark workspace: ${scenario}\n` } });
  } finally {
    if (saved === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = saved;
  }
  const repo = await pending;
  if (path.dirname(repo.dir) !== base || !path.basename(repo.dir).startsWith(TMP_REPO_PREFIX)) {
    await repo.cleanup();
    throw new Error(`harness: benchmark repository ${repo.dir} is not directly under ${base}`);
  }
  let removed = false;
  const removeSync = (): void => {
    if (removed) return;
    removed = true;
    rmSync(repo.dir, { recursive: true, force: true });
  };
  process.once('exit', removeSync);
  return { repo, dir: repo.dir, base, removeSync };
}

/** Let every file written so far age past the change-detection racy-clean window, as a real workspace has. */
export async function agePastRacyWindow(): Promise<void> {
  await sleep(Number(RACY_WINDOW_NS / 1_000_000n) + 100);
}

const WORDS = [
  'module', 'import', 'export', 'function', 'return', 'const', 'value', 'config', 'render', 'handler', 'request',
  'response', 'client', 'server', 'build', 'index', 'table', 'column', 'record', 'update', 'delete', 'insert',
  'select', 'where', 'order', 'group', 'limit', 'offset', 'string', 'number', 'boolean', 'object', 'array', 'map',
  'filter', 'reduce', 'promise', 'await', 'async', 'error', 'warning', 'debug', 'trace', 'metric', 'counter',
];

/** `bytes` of ASCII prose-like text (short words, spaces, newlines): valid UTF-8 with no secret-shaped token. */
export function textPool(bytes: number, seed: number): Buffer {
  const rng = seededRng(seed);
  const out = Buffer.allocUnsafe(bytes);
  let at = 0;
  let column = 0;
  while (at < bytes) {
    const word = WORDS[Math.floor(rng() * WORDS.length)] as string;
    const sep = column > 72 ? '\n' : ' ';
    column = sep === '\n' ? 0 : column + word.length + 1;
    at += out.write(word + sep, at, 'latin1');
  }
  return out;
}

/** `bytes` of binary data: bytes 0x80–0xFF with a NUL every 64th byte, so it is not UTF-8 and holds no ASCII token. */
export function binaryPool(bytes: number, seed: number): Buffer {
  const rng = seededRng(seed);
  const out = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i += 1) out[i] = i % 64 === 63 ? 0 : 0x80 + Math.floor(rng() * 0x80);
  return out;
}

interface FileJob {
  rel: string;
  size: number;
  pool: Buffer;
  /** Distinguishes otherwise identical content, so git cannot deduplicate the workspace away. */
  tag: string;
}

async function writeJob(dir: string, job: FileJob, index: number): Promise<void> {
  const target = path.join(dir, job.rel);
  await mkdir(path.dirname(target), { recursive: true });
  const header = Buffer.from(`${job.tag}\n`, 'latin1');
  const bodyLength = Math.max(0, job.size - header.length);
  const offset = (index * 7919 * 4096) % Math.max(1, job.pool.length - bodyLength);
  const handle = await open(target, 'w');
  try {
    await handle.writev([header, job.pool.subarray(offset, offset + bodyLength)]);
  } finally {
    await handle.close();
  }
}

async function writeJobs(dir: string, jobs: readonly FileJob[], concurrency: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      await writeJob(dir, jobs[index] as FileJob, index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/**
 * About `totalBytes` of mixed text and binary files (64 KiB, 256 KiB, 1 MiB and 4 MiB, alternating text/binary)
 * under data/. Returns the file count.
 */
export async function writeMixedWorkspace(dir: string, totalBytes: number): Promise<number> {
  const sizes = [64 * KIB, 256 * KIB, 1 * MIB, 4 * MIB];
  const text = textPool(8 * MIB, 0x7e57);
  const binary = binaryPool(8 * MIB, 0xb1a7);
  const jobs: FileJob[] = [];
  for (let i = 0, total = 0; total < totalBytes; i += 1) {
    const size = sizes[i % sizes.length] as number;
    const isText = i % 2 === 0;
    const dirName = `d${String(Math.floor(i / 64)).padStart(3, '0')}`;
    jobs.push({ rel: `data/${dirName}/f${String(i).padStart(5, '0')}.${isText ? 'txt' : 'bin'}`, size, pool: isText ? text : binary, tag: `file ${i}` });
    total += size;
  }
  await writeJobs(dir, jobs, 8);
  return jobs.length;
}

/** Relative path of the i-th file of a many-files workspace: 100 directories of 1000 files each at 100k. */
export function manyFilesPath(i: number): string {
  return `src/m${String(Math.floor(i / 1000)).padStart(3, '0')}/file${String(i).padStart(6, '0')}.txt`;
}

/** `count` small text files (256 B – ~2 KiB, about 1.15 KiB on average) under src/. */
export async function writeManyFilesWorkspace(dir: string, count: number): Promise<void> {
  const text = textPool(1 * MIB, 0x5a11);
  const jobs: FileJob[] = [];
  for (let i = 0; i < count; i += 1) jobs.push({ rel: manyFilesPath(i), size: 256 + ((i * 37) % 1792), pool: text, tag: `file ${i}` });
  await writeJobs(dir, jobs, 64);
}

/** Rewrite a text file in place with new content of the same size (`tag` makes the content differ). */
export async function rewriteTextFile(dir: string, rel: string, size: number, tag: string): Promise<void> {
  const header = `${tag}\n`;
  const body = textPool(Math.max(0, size - Buffer.byteLength(header)), size ^ tag.length);
  await writeFile(path.join(dir, rel), Buffer.concat([Buffer.from(header, 'latin1'), body]));
}

/** A tool output of about `bytes` UTF-8 bytes in which every other line carries a fake credential from the corpus. */
export function secretHeavyOutput(bytes: number): string {
  const corpus = secretCorpus();
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; total < bytes; i += 1) {
    const sample = corpus[i % corpus.length]!;
    const line =
      i % 2 === 0
        ? `[step ${i}] exported ${sample.kind} credential for deploy: ${sample.value}\n`
        : `[step ${i}] compiled module m${i % 997} in ${(i * 13) % 97} ms, 0 warnings\n`;
    lines.push(line);
    total += Buffer.byteLength(line);
  }
  return lines.join('');
}

// ── store resets (scenario F) ────────────────────────────────────────────────────────────────────────

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: isolatedGitEnv(), maxBuffer: 64 * MIB });
  return stdout;
}

/**
 * Untimed: close the store, then remove everything checkpointing wrote (the .ckpt store, refs/checkpoints/** and
 * the now-unreachable git objects), so the next checkpoint is a true initial snapshot into an empty store rather
 * than a re-hash of objects that already exist.
 */
export async function emptyStore(store: Store): Promise<void> {
  await store.close();
  rmSync(path.join(store.repoDir, STORE_DIR_NAME), { recursive: true, force: true });
  const refs = (await git(store.repoDir, ['for-each-ref', '--format=%(refname)', 'refs/checkpoints/'])).split('\n').filter((r) => r !== '');
  for (const ref of refs) await git(store.repoDir, ['update-ref', '-d', ref]);
  await git(store.repoDir, ['prune', '--expire=now']);
}
