/**
 * TASK-016: the observe-only `phaseTimer` seam for SPEC-002's 7 checkpoint phases ("Measurement definition").
 *
 * Everything runs on the real CheckpointEngine and LocalBackend in a tmpGitRepo() (engineFixture). Nothing is stubbed.
 * Every fixture gets the same fixed clock, seeded randomness and event ids, so two runs of the same scenario are
 * comparable byte for byte: the only difference between them is the timer.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PHASES, type Phase } from '../../../bench/results.schema.js';
import type { CheckpointEngineOptions, CheckpointPhase } from '../../../src/engine/engine.js';
import type { AgentStateObject, Checkpoint, LedgerEvent } from '../../../src/model/types.js';
import type { LocalBackendOptions } from '../../../src/storage/local-backend.js';
import { allEvents, engineFixture, removeFile, treeOf, writeFiles } from '../../integration/engine/support.js';

type Timer = { add(phase: CheckpointPhase, ms: number): void };
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// (e), compile time: the engine's union is bench's Phase, and the backend's member is the engine's member.
const phaseUnionMatchesBench: Equal<CheckpointPhase, Phase> = true;
const backendMemberMatchesEngine: Equal<NonNullable<LocalBackendOptions['phaseTimer']>, NonNullable<CheckpointEngineOptions['phaseTimer']>> = true;
// (e), run time: `satisfies` rejects a missing or an extra key, so these keys are exactly CheckpointPhase.
const CHECKPOINT_PHASE_KEYS = {
  changeDetection: true,
  scanRedact: true,
  hash: true,
  blobWrite: true,
  gitCommit: true,
  ledgerAppend: true,
  indexUpdate: true,
} satisfies Record<CheckpointPhase, true>;

const SNAPSHOT_PHASES: readonly CheckpointPhase[] = ['changeDetection', 'scanRedact', 'hash', 'blobWrite'];
const STORAGE_PHASES: readonly CheckpointPhase[] = ['blobWrite', 'gitCommit', 'ledgerAppend', 'indexUpdate'];

const FILES = {
  'README.md': '# phase timer fixture\n',
  'src/app.ts': 'export const answer = 42;\n',
  'src/util/strings.ts': 'export const greeting = "hello";\n',
  'docs/notes.txt': 'first draft\n',
};

/** Deterministic stand-in for crypto randomness (run ids), so every fixture names its run identically. */
function seededRandom(): (size: number) => Uint8Array {
  let state = 7;
  return (size) =>
    Uint8Array.from({ length: size }, () => {
      state = (state * 73 + 41) % 256;
      return state;
    });
}

/** Deterministic `evt_<uuid>` ids. */
function counterEventIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `evt_00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  };
}

interface Recorder {
  readonly calls: Array<{ phase: CheckpointPhase; ms: number }>;
  readonly timer: Timer;
  recording: boolean;
}

function recorder(): Recorder {
  const rec: Recorder = {
    calls: [],
    recording: false,
    timer: {
      add(phase, ms) {
        if (rec.recording) rec.calls.push({ phase, ms });
      },
    },
  };
  return rec;
}

interface Outcome {
  readonly checkpoints: Checkpoint[];
  readonly events: LedgerEvent[];
  readonly trees: string[];
  readonly states: AgentStateObject[];
  /** Wall time of the measured checkpoint() call (the second one, over changed text files). */
  readonly wallMs: number;
}

/**
 * startRun, a full first checkpoint, then text-file changes (one edited, one added, one deleted) and the measured
 * second, incremental checkpoint. `measuring` is called around that second call only.
 */
async function runScenario(
  timers: { engine?: Timer; backend?: Timer },
  measuring: (on: boolean) => void = () => undefined,
): Promise<Outcome> {
  const fx = await engineFixture({
    files: FILES,
    engine: timers.engine === undefined ? {} : { phaseTimer: timers.engine },
    backend: {
      random: seededRandom(),
      newEventId: counterEventIds(),
      ...(timers.backend === undefined ? {} : { phaseTimer: timers.backend }),
    },
  });
  try {
    const run = await fx.engine.startRun({ agent: 'phase-timer' });
    const first = await fx.engine.checkpoint(run.run_id);
    fx.clock.tick(1_000);
    await writeFiles(fx.repo.dir, {
      'src/app.ts': 'export const answer = 43; // edited\n',
      'src/added.ts': 'export const added = true;\n',
    });
    await removeFile(fx.repo.dir, 'docs/notes.txt');

    measuring(true);
    const start = performance.now();
    const second = await fx.engine.checkpoint(run.run_id);
    const wallMs = performance.now() - start;
    measuring(false);

    const checkpoints = [first, second];
    return {
      checkpoints,
      events: await allEvents(fx.backend, run.run_id),
      trees: await Promise.all(checkpoints.map((c) => treeOf(fx.repo.dir, c.workspace_commit))),
      states: await Promise.all(checkpoints.map((c) => fx.backend.getState({ run_id: c.run_id, checkpoint_id: c.checkpoint_id }))),
      wallMs,
    };
  } finally {
    await fx.cleanup();
  }
}

describe('phaseTimer: SPEC-002 per-phase checkpoint timings on the real engine and backend', () => {
  let baseline: Outcome;
  let timed: Outcome;
  let rec: Recorder;
  let throwing: Outcome;
  let throwCalls = 0;

  beforeAll(async () => {
    baseline = await runScenario({});

    rec = recorder();
    timed = await runScenario({ engine: rec.timer, backend: rec.timer }, (on) => {
      rec.recording = on;
    });

    const thrower: Timer = {
      add() {
        throwCalls += 1;
        throw new Error('phase timer failure');
      },
    };
    throwing = await runScenario({ engine: thrower, backend: thrower });
  }, 180_000);

  it('(a) one checkpoint() over changed text files reports all 7 phases, each at least once, with finite ms >= 0', () => {
    expect(rec.calls.length).toBeGreaterThan(0);
    expect(new Set(rec.calls.map((call) => call.phase))).toEqual(new Set(PHASES));
    for (const phase of PHASES) expect(rec.calls.filter((call) => call.phase === phase).length, phase).toBeGreaterThanOrEqual(1);
    for (const call of rec.calls) {
      expect(Number.isFinite(call.ms), `${call.phase} ms is finite`).toBe(true);
      expect(call.ms, call.phase).toBeGreaterThanOrEqual(0);
    }
    // The measured checkpoint really did detect, redact, hash and stage the changed files.
    expect(timed.checkpoints[1]?.parent_checkpoint_id).toBe(timed.checkpoints[0]?.checkpoint_id);
    expect(timed.trees[1]).not.toBe(timed.trees[0]);
  });

  it('(b) the reported ms sum to no more than the wall time of the checkpoint() call', () => {
    const sum = rec.calls.reduce((total, call) => total + call.ms, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(timed.wallMs);
  });

  it('(c) results are identical with and without a timer: commit trees, ledger events, state hash inputs', () => {
    expect(timed.trees).toEqual(baseline.trees);
    // Ids and timestamps come from the same injected sources, so even they agree; the event types and payloads are
    // compared on their own first, so a failure names what differs.
    expect(timed.events.map((e) => [e.type, e.payload])).toEqual(baseline.events.map((e) => [e.type, e.payload]));
    expect(timed.events).toEqual(baseline.events);
    expect(timed.states).toEqual(baseline.states);
    expect(timed.checkpoints.map((c) => c.state_hash)).toEqual(baseline.checkpoints.map((c) => c.state_hash));
    expect(timed.checkpoints).toEqual(baseline.checkpoints);
  });

  it('(d) a timer whose add() throws does not change the result', () => {
    expect(throwCalls).toBeGreaterThan(0);
    expect(throwing.trees).toEqual(baseline.trees);
    expect(throwing.events).toEqual(baseline.events);
    expect(throwing.states).toEqual(baseline.states);
    expect(throwing.checkpoints).toEqual(baseline.checkpoints);
  });

  it('(e) the CheckpointPhase keys equal bench/results.schema.ts PHASES, as a set', () => {
    expect(phaseUnionMatchesBench).toBe(true);
    expect(backendMemberMatchesEngine).toBe(true);
    expect(new Set(Object.keys(CHECKPOINT_PHASE_KEYS))).toEqual(new Set(PHASES));
    expect(Object.keys(CHECKPOINT_PHASE_KEYS)).toHaveLength(PHASES.length);
  });

  it('the engine timer carries the snapshot phases and the backend timer the storage phases', async () => {
    const engineRec = recorder();
    const backendRec = recorder();
    const split = await runScenario({ engine: engineRec.timer, backend: backendRec.timer }, (on) => {
      engineRec.recording = on;
      backendRec.recording = on;
    });
    expect(new Set(engineRec.calls.map((call) => call.phase))).toEqual(new Set(SNAPSHOT_PHASES));
    expect(new Set(backendRec.calls.map((call) => call.phase))).toEqual(new Set(STORAGE_PHASES));
    expect(split.checkpoints).toEqual(baseline.checkpoints);
  }, 120_000);
});
