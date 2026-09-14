/**
 * Per-phase timing capture for checkpoint benchmarks (SPEC-002 "Measurement definition").
 *
 * `npm run bench` writes vitest's native benchmark report to bench/results.json. vitest reports no
 * p95 and no per-phase timings, and strips raw samples from the report. A scenario bench
 * (bench/scenarios/<id>.bench.ts, owned by SPEC-014) adds the SPEC-002 BenchResult fields with a
 * recorder:
 *
 *   const recorder = phaseRecorder('a-small-change');
 *   bench('checkpoint', async () => {
 *     const { totalMs, phases } = await measuredCheckpoint();   // instrumented call-to-ACK
 *     recorder.record({ totalMs, phases });
 *   }, { ...recorder.options });
 *
 * The recorder resets at the start of each tinybench mode (warmup, run). When the measured run
 * ends, it writes `scenario`, `budgetMs` (from the SPEC-002 budget table), `p95Ms` and `phases`
 * (each phase's p95) onto the task result. vitest copies them into the benchmark entry in
 * bench/results.json, where bench/results.schema.ts `readBenchResults()` finds them.
 *
 * NOT MEASURED (DEC-049(1), DEC-050): a sample reports a phase it cannot measure as `null`, never `0`.
 * A phase's p95 is `null` when ANY sample left it unmeasured: a percentile over a subset of the
 * iterations would present a partial measurement as a whole one.
 */
import { BUDGETS, isKnownScenario, PHASES, type BenchResult, type Phase, type PhaseTimings } from './results.schema.js';

/** One sample's per-phase durations in milliseconds; `null` = not measured in this sample. */
export type PhaseDurations = Record<Phase, number | null>;

export interface CheckpointSample {
  /** `checkpoint()` call to ACK, in milliseconds. */
  totalMs: number;
  phases: PhaseDurations;
}

/** Nearest-rank percentile (p in (0, 100]) of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('percentile: values must be non-empty');
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile: p must be in (0, 100], got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] as number;
}

function assertDuration(label: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`phaseRecorder: ${label} must be a finite number >= 0, got ${String(value)}`);
  }
}

function assertPhaseDuration(label: string, value: unknown): asserts value is number | null {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`phaseRecorder: ${label} must be a finite number >= 0, or null when not measured, got ${String(value)}`);
  }
}

/** p95 of one phase over the samples, or null when any sample did not measure it. */
function phaseP95(samples: readonly CheckpointSample[], phase: Phase): number | null {
  const values: number[] = [];
  for (const sample of samples) {
    const value = sample.phases[phase];
    if (value === null) return null;
    values.push(value);
  }
  return percentile(values, 95);
}

/** Hook shape accepted by vitest `bench()` options (tinybench `setup` / `teardown`). */
type BenchHook = (task: object, mode: string) => void;

export interface PhaseRecorder {
  readonly scenario: string;
  /** Record one measured checkpoint. Throws on a missing or invalid phase duration (null is valid). */
  record(sample: CheckpointSample): void;
  /** Spread into `bench()` options. */
  readonly options: { setup: BenchHook; teardown: BenchHook };
}

/** A recorder for one SPEC-002 scenario. Throws for an id that is not in the budget table. */
export function phaseRecorder(scenario: string): PhaseRecorder {
  if (!isKnownScenario(scenario)) {
    throw new RangeError(`phaseRecorder: "${scenario}" is not a SPEC-002 scenario (known: ${Object.keys(BUDGETS).join(', ')})`);
  }
  const budgetMs = BUDGETS[scenario] ?? null;
  let samples: CheckpointSample[] = [];

  const setup: BenchHook = () => {
    samples = [];
  };

  const teardown: BenchHook = (task, mode) => {
    if (mode !== 'run') return;
    if (samples.length === 0) {
      throw new Error(`phaseRecorder(${scenario}): no samples recorded; call recorder.record() inside the bench function`);
    }
    const phases = Object.fromEntries(PHASES.map((phase) => [phase, phaseP95(samples, phase)])) as PhaseTimings;
    const fields: BenchResult = { scenario, budgetMs, p95Ms: percentile(samples.map((s) => s.totalMs), 95), phases };
    const target = task as { result?: Record<string, unknown> };
    target.result = { ...(target.result ?? {}), ...fields };
  };

  return {
    scenario,
    record(sample: CheckpointSample): void {
      assertDuration('totalMs', sample.totalMs);
      if (typeof sample.phases !== 'object' || sample.phases === null) {
        throw new RangeError('phaseRecorder: phases must be an object with all 7 SPEC-002 phase keys');
      }
      for (const phase of PHASES) {
        if (!(phase in sample.phases)) throw new RangeError(`phaseRecorder: phases.${phase} is missing (use null when not measured)`);
        assertPhaseDuration(`phases.${phase}`, sample.phases[phase]);
      }
      samples.push({ totalMs: sample.totalMs, phases: { ...sample.phases } });
    },
    options: { setup, teardown },
  };
}
