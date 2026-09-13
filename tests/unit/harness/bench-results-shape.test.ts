/**
 * SPEC-002: every scenario entry in bench/results.json has all 7 phase timings
 * (changeDetection, scanRedact, hash, blobWrite, gitCommit, ledgerAppend, indexUpdate).
 *
 * The shape is asserted against the fixture results file, and against bench/results.json when a
 * local `npm run bench` has produced one. A plumbing test also runs a real
 * `vitest bench --outputJson` on a sentinel bench in the OS temp dir, to prove bench/phases.ts gets
 * phase timings into vitest's report. That bench records constant numbers and times nothing,
 * so it is not a performance measurement.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { scenarioEntries, SCENARIOS, validateReportShape, type BenchReport } from '../../../bench/check-budgets.js';
import { percentile, phaseRecorder, PHASES, type PhaseDurations } from '../../../bench/phases.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FIXTURE = path.join(here, 'fixtures', 'bench-results.within-budget.json');
const LOCAL_RESULTS = path.join(repoRoot, 'bench', 'results.json');

function expectAllPhaseTimings(report: BenchReport): void {
  expect(validateReportShape(report)).toEqual([]);
  const entries = scenarioEntries(report);
  expect(entries.length).toBeGreaterThan(0);
  for (const { label, entry } of entries) {
    const phases = entry.phases as Record<string, Record<string, number>>;
    expect(Object.keys(phases).sort(), label).toEqual([...PHASES].sort());
    for (const phase of PHASES) {
      for (const stat of ['mean', 'p95', 'max']) {
        expect(Number.isFinite(phases[phase]![stat]), `${label} ${phase}.${stat}`).toBe(true);
      }
    }
  }
}

describe('bench results shape', () => {
  it('names exactly the 7 SPEC-002 phases', () => {
    expect([...PHASES]).toEqual(['changeDetection', 'scanRedact', 'hash', 'blobWrite', 'gitCommit', 'ledgerAppend', 'indexUpdate']);
  });

  it('every scenario entry in the fixture results file has all 7 phase timings', () => {
    const report = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BenchReport;
    expectAllPhaseTimings(report);
    const ids = new Set(scenarioEntries(report).map((e) => e.scenarioId));
    for (const scenario of SCENARIOS) expect(ids.has(scenario.id), scenario.id).toBe(true);
  });

  it.runIf(existsSync(LOCAL_RESULTS))('every scenario entry in the local results.json has all 7 phase timings', () => {
    expectAllPhaseTimings(JSON.parse(readFileSync(LOCAL_RESULTS, 'utf8')) as BenchReport);
  });

  it('rejects entries with a missing phase, a non-numeric timing, or no phases at all', () => {
    const base = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BenchReport;
    const entry = () => base.files[0]!.groups[0]!.benchmarks[0]!;

    delete (entry().phases as Record<string, unknown>).ledgerAppend;
    expect(validateReportShape(base).join('\n')).toMatch(/missing phase timing "ledgerAppend"/);

    (entry().phases as Record<string, unknown>).ledgerAppend = { mean: 'fast', p95: 1, max: 1 };
    expect(validateReportShape(base).join('\n')).toMatch(/phases\.ledgerAppend\.mean/);

    delete entry().phases;
    expect(validateReportShape(base).join('\n')).toMatch(/missing "phases"/);
  });
});

describe('phaseRecorder', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
    expect(() => percentile([], 95)).toThrow(RangeError);
  });

  it('rejects a sample with a missing or invalid phase', () => {
    const recorder = phaseRecorder();
    const phases = Object.fromEntries(PHASES.map((p) => [p, 1])) as PhaseDurations;
    expect(() => recorder.record({ totalMs: 7, phases })).not.toThrow();
    expect(() => recorder.record({ totalMs: -1, phases })).toThrow(/totalMs/);
    const { hash: _omitted, ...withoutHash } = phases;
    expect(() => recorder.record({ totalMs: 7, phases: withoutHash as PhaseDurations })).toThrow(/phases\.hash/);
  });

  it('attaches p95 and phase stats to the task result on the measured run only', () => {
    const recorder = phaseRecorder();
    const task: { result?: Record<string, unknown> } = {};
    const sample = (totalMs: number, v: number) => ({ totalMs, phases: Object.fromEntries(PHASES.map((p) => [p, v])) as PhaseDurations });

    recorder.options.setup(task, 'warmup');
    recorder.record(sample(999, 999));
    recorder.options.teardown(task, 'warmup');
    expect(task.result).toBeUndefined();

    recorder.options.setup(task, 'run');
    for (let i = 1; i <= 20; i++) recorder.record(sample(i, i / 10));
    recorder.options.teardown(task, 'run');
    expect(task.result?.p95).toBe(19);
    const phases = task.result?.phases as Record<string, { mean: number; p95: number; max: number }>;
    expect(phases.gitCommit?.mean).toBeCloseTo(1.05, 10);
    expect(phases.gitCommit?.p95).toBe(1.9);
    expect(phases.gitCommit?.max).toBe(2);
  });

  it(
    'phase timings reach the report written by vitest bench --outputJson',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'ckpt-bench-plumbing-'));
      try {
        await mkdir(path.join(root, 'bench'));
        await copyFile(path.join(repoRoot, 'bench', 'phases.ts'), path.join(root, 'bench', 'phases.ts'));
        await writeFile(
          path.join(root, 'bench', 'z-plumbing.bench.ts'),
          [
            "import { bench, describe } from 'vitest';",
            "import { PHASES, phaseRecorder, type PhaseDurations } from './phases.js';",
            'const recorder = phaseRecorder();',
            'const phases = Object.fromEntries(PHASES.map((p, i) => [p, i + 1])) as PhaseDurations;',
            "describe('z-plumbing', () => {",
            "  bench('checkpoint', () => { recorder.record({ totalMs: 12, phases }); }, { iterations: 5, time: 0, ...recorder.options });",
            '});',
            '',
          ].join('\n'),
        );
        const out = path.join(root, 'results.json');
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
        await execFileAsync(
          process.execPath,
          [path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'bench', '--run', '--outputJson', out, '--config', path.join(repoRoot, 'vitest.config.ts'), '--root', root],
          { cwd: root, env, maxBuffer: 16 * 1024 * 1024 },
        );

        const report = JSON.parse(await readFile(out, 'utf8')) as BenchReport;
        expectAllPhaseTimings(report);
        const [only] = scenarioEntries(report);
        expect(only?.scenarioId).toBe('z-plumbing');
        expect(only?.entry.p95).toBe(12);
        expect((only?.entry.phases as Record<string, { max: number }>).indexUpdate?.max).toBe(7);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
