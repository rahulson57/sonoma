/**
 * Per-phase timing capture for checkpoint benchmarks (SPEC-002 "Measurement definition").
 *
 * `npm run bench` writes vitest's native benchmark report to bench/results.json. That report has
 * no per-phase timings and no p95, and vitest strips raw samples from it. A bench attaches both
 * by using a recorder:
 *
 *   const recorder = phaseRecorder();
 *   bench('checkpoint', async () => {
 *     const { totalMs, phases } = await measuredCheckpoint();   // instrumented call-to-ACK
 *     recorder.record({ totalMs, phases });
 *   }, { ...recorder.options });
 *
 * The recorder resets at the start of each tinybench mode (warmup, run). When the measured run
 * ends, it writes `p95` (total) and `phases` onto the task result, and vitest copies both into
 * the benchmark entry in bench/results.json. bench/check-budgets.ts reads them from there.
 */

export const PHASES = [
  'changeDetection',
  'scanRedact',
  'hash',
  'blobWrite',
  'gitCommit',
  'ledgerAppend',
  'indexUpdate',
] as const;

export type Phase = (typeof PHASES)[number];
export type PhaseDurations = Record<Phase, number>;

/** Summary of one phase across a benchmark's measured iterations, in milliseconds. */
export interface PhaseStats {
  mean: number;
  p95: number;
  max: number;
}
export type PhaseTimings = Record<Phase, PhaseStats>;

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

export function summarize(values: readonly number[]): PhaseStats {
  if (values.length === 0) throw new RangeError('summarize: values must be non-empty');
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { mean, p95: percentile(values, 95), max: Math.max(...values) };
}

function assertDuration(label: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`phaseRecorder: ${label} must be a finite number >= 0, got ${String(value)}`);
  }
}

/** Hook shape accepted by vitest `bench()` options (tinybench `setup` / `teardown`). */
type BenchHook = (task: object, mode: string) => void;

export interface PhaseRecorder {
  /** Record one measured checkpoint. Throws on a missing or invalid phase duration. */
  record(sample: CheckpointSample): void;
  /** Spread into `bench()` options. */
  readonly options: { setup: BenchHook; teardown: BenchHook };
}

export function phaseRecorder(): PhaseRecorder {
  let samples: CheckpointSample[] = [];

  const setup: BenchHook = () => {
    samples = [];
  };

  const teardown: BenchHook = (task, mode) => {
    if (mode !== 'run') return;
    if (samples.length === 0) {
      throw new Error('phaseRecorder: no samples recorded; call recorder.record() inside the bench function');
    }
    const phases = Object.fromEntries(
      PHASES.map((phase) => [phase, summarize(samples.map((s) => s.phases[phase]))]),
    ) as PhaseTimings;
    const target = task as { result?: Record<string, unknown> };
    target.result = { ...(target.result ?? {}), p95: percentile(samples.map((s) => s.totalMs), 95), phases };
  };

  return {
    record(sample: CheckpointSample): void {
      assertDuration('totalMs', sample.totalMs);
      for (const phase of PHASES) assertDuration(`phases.${phase}`, sample.phases?.[phase]);
      samples.push({ totalMs: sample.totalMs, phases: { ...sample.phases } });
    },
    options: { setup, teardown },
  };
}
