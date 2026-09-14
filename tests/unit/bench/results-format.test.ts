/**
 * SPEC-002: every entry in bench/results.json carries a `phases` object with exactly the 7 keys
 * changeDetection, scanRedact, hash, blobWrite, gitCommit, ledgerAppend, indexUpdate.
 *
 * Checked three ways:
 * - against the committed fixtures;
 * - against bench/results.json when a local `npm run bench` has written one;
 * - end to end: a real `vitest bench --run --outputJson` run with this repository's config, on a
 *   plumbing bench in the OS temp dir. It proves bench/phases.ts gets the BenchResult fields into
 *   vitest's report. That bench records constant numbers and times nothing, so it is not a
 *   performance measurement, and it never lands under bench/scenarios/.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { percentile, phaseRecorder, type PhaseDurations } from '../../../bench/phases.js';
import { BUDGETS, PHASES, readBenchResults, unmeasuredPhases, type ReadResults } from '../../../bench/results.schema.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const FIXTURES = ['within-budget.json', 'over-budget.json', 'not-measured.json', 'null-budget-unmeasured.json'].map((f) =>
  path.join(here, 'fixtures', f),
);
const LOCAL_RESULTS = path.join(repoRoot, 'bench', 'results.json');
const SORTED_PHASES = [...PHASES].sort();

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** Exactly the 7 keys; each a finite duration >= 0, or null = not measured (DEC-050). */
function expectExactPhases({ results, errors }: ReadResults): void {
  expect(errors).toEqual([]);
  for (const { where, result } of results) {
    expect(Object.keys(result.phases).sort(), where).toEqual(SORTED_PHASES);
    for (const phase of PHASES) {
      const value = result.phases[phase];
      expect(value === null || (Number.isFinite(value) && value >= 0), `${where} ${phase}`).toBe(true);
    }
  }
}

/** The first benchmark entry of a vitest report, as a mutable record. */
function firstEntry(report: unknown): Record<string, unknown> & { phases: Record<string, unknown> } {
  return (report as { files: Array<{ groups: Array<{ benchmarks: unknown[] }> }> }).files[0]!.groups[0]!.benchmarks[0] as never;
}

describe('bench results format', () => {
  it('names exactly the 7 SPEC-002 phases', () => {
    expect([...PHASES]).toEqual(['changeDetection', 'scanRedact', 'hash', 'blobWrite', 'gitCommit', 'ledgerAppend', 'indexUpdate']);
  });

  it.each(FIXTURES.map((f) => [path.basename(f), f]))('every entry in %s has a phases object with exactly the 7 keys', (_name, file) => {
    const read = readBenchResults(readJson(file));
    expectExactPhases(read);
    expect(read.results.map((r) => r.result.scenario).sort()).toEqual(Object.keys(BUDGETS).sort());
  });

  // Title avoids the literal bench path prefix: vitest-config.test.ts greps the plain `vitest list` output for it.
  it.runIf(existsSync(LOCAL_RESULTS))('every entry in the local results file from npm run bench has a phases object with exactly the 7 keys', () => {
    // Before the SPEC-014 scenarios exist, `npm run bench` writes an empty report; the per-entry rule still holds.
    expectExactPhases(readBenchResults(readJson(LOCAL_RESULTS)));
  });

  it('reads a bare BenchResult[] too', () => {
    const phases = Object.fromEntries(PHASES.map((p) => [p, 1]));
    const read = readBenchResults([{ scenario: 'e-noop', budgetMs: 100, p95Ms: 7, phases }]);
    expectExactPhases(read);
    expect(read.results).toHaveLength(1);
  });

  it('rejects a missing phase, an extra phase key, a non-numeric timing, or no phases at all', () => {
    const report = readJson(FIXTURES[0]!);
    const entry = firstEntry(report);
    const errorsOf = () => readBenchResults(report).errors.join('\n');

    delete entry.phases.ledgerAppend;
    expect(errorsOf()).toMatch(/missing phase timing "ledgerAppend"/);

    entry.phases.ledgerAppend = 'fast';
    expect(errorsOf()).toMatch(/phases\.ledgerAppend must be a finite number/);

    entry.phases.ledgerAppend = 1;
    entry.phases.distill = 3;
    expect(errorsOf()).toMatch(/unexpected phase key "distill"/);

    delete (entry as { phases?: unknown }).phases;
    expect(errorsOf()).toMatch(/missing "phases"/);
  });

  it('accepts null (not measured) for any phase, and nothing else in its place', () => {
    const report = readJson(FIXTURES[0]!);
    const entry = firstEntry(report);
    const errorsOf = () => readBenchResults(report).errors.join('\n');

    for (const phase of PHASES) entry.phases[phase] = null;
    const read = readBenchResults(report);
    expect(read.errors).toEqual([]);
    expect(unmeasuredPhases(read.results[0]!.result)).toEqual([...PHASES]);

    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, '0', false, {}]) {
      entry.phases.hash = bad;
      expect(errorsOf(), String(bad)).toMatch(/phases\.hash must be a finite number >= 0, or null when not measured/);
    }
  });

  it('names the unmeasured phases of a result in SPEC-002 order', () => {
    const read = readBenchResults(readJson(path.join(here, 'fixtures', 'not-measured.json')));
    const noop = read.results.find((r) => r.result.scenario === 'e-noop')!;
    expect(unmeasuredPhases(noop.result)).toEqual(['scanRedact', 'gitCommit']);
    expect(read.results.filter((r) => r.result.scenario !== 'e-noop').every((r) => unmeasuredPhases(r.result).length === 0)).toBe(true);
  });

  it('rejects malformed BenchResult fields and non-reports', () => {
    const report = readJson(FIXTURES[0]!);
    const entry = firstEntry(report);
    entry.budgetMs = '500';
    entry.p95Ms = -1;
    entry.scenario = '';
    const errors = readBenchResults(report).errors.join('\n');
    expect(errors).toMatch(/"budgetMs" must be null or a finite number/);
    expect(errors).toMatch(/"p95Ms" must be a finite number/);
    expect(errors).toMatch(/"scenario" must be a non-empty string/);
    expect(readBenchResults({ nope: true }).errors).toHaveLength(1);
    expect(readBenchResults(null).errors).toHaveLength(1);
  });
});

describe('phaseRecorder', () => {
  const sample = (totalMs: number, v: number) => ({ totalMs, phases: Object.fromEntries(PHASES.map((p) => [p, v])) as PhaseDurations });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
    expect(() => percentile([], 95)).toThrow(RangeError);
  });

  it('only records scenarios from the SPEC-002 budget table', () => {
    expect(() => phaseRecorder('z-unknown')).toThrow(/not a SPEC-002 scenario/);
    for (const scenario of Object.keys(BUDGETS)) expect(phaseRecorder(scenario).scenario).toBe(scenario);
  });

  it('rejects a sample with a missing or invalid phase', () => {
    const recorder = phaseRecorder('e-noop');
    expect(() => recorder.record(sample(7, 1))).not.toThrow();
    expect(() => recorder.record(sample(-1, 1))).toThrow(/totalMs/);
    const { hash: _omitted, ...withoutHash } = sample(7, 1).phases;
    expect(() => recorder.record({ totalMs: 7, phases: withoutHash as PhaseDurations })).toThrow(/phases\.hash/);
    // null is the only way to say "not measured": an undefined, NaN or negative value is still rejected.
    for (const bad of [undefined, Number.NaN, -1]) {
      expect(() => recorder.record({ totalMs: 7, phases: { ...sample(7, 1).phases, hash: bad as unknown as number } })).toThrow(/phases\.hash/);
    }
    expect(() => recorder.record({ totalMs: 7, phases: { ...sample(7, 1).phases, hash: null } })).not.toThrow();
  });

  it('reports a phase null when it was not measured, and never as 0', () => {
    const recorder = phaseRecorder('e-noop');
    const task: { result?: Record<string, unknown> } = {};
    recorder.options.setup(task, 'run');
    for (let i = 1; i <= 20; i++) recorder.record({ totalMs: i, phases: { ...sample(i, i / 10).phases, hash: null, blobWrite: null } });
    recorder.options.teardown(task, 'run');

    const phases = task.result?.phases as Record<string, number | null>;
    expect(phases.hash).toBeNull();
    expect(phases.blobWrite).toBeNull();
    expect(phases.gitCommit).toBe(1.9);
    expectExactPhases(readBenchResults([task.result]));
  });

  it('reports a phase null when ANY sample left it unmeasured, rather than a p95 of the rest', () => {
    const recorder = phaseRecorder('b-many-files');
    const task: { result?: Record<string, unknown> } = {};
    recorder.options.setup(task, 'run');
    for (let i = 1; i <= 19; i++) recorder.record(sample(i, i));
    recorder.record({ totalMs: 20, phases: { ...sample(20, 20).phases, ledgerAppend: null } });
    recorder.options.teardown(task, 'run');

    const phases = task.result?.phases as Record<string, number | null>;
    expect(phases.ledgerAppend).toBeNull();
    expect(phases.indexUpdate).toBe(19);
  });

  it('attaches the BenchResult fields to the task result on the measured run only', () => {
    const recorder = phaseRecorder('e-noop');
    const task: { result?: Record<string, unknown> } = {};

    recorder.options.setup(task, 'warmup');
    recorder.record(sample(999, 999));
    recorder.options.teardown(task, 'warmup');
    expect(task.result).toBeUndefined();

    recorder.options.setup(task, 'run');
    for (let i = 1; i <= 20; i++) recorder.record(sample(i, i / 10));
    recorder.options.teardown(task, 'run');
    expect(task.result).toMatchObject({ scenario: 'e-noop', budgetMs: 100, p95Ms: 19 });
    expect((task.result?.phases as Record<string, number>).gitCommit).toBe(1.9);
    expectExactPhases(readBenchResults([task.result]));
  });

  it('refuses to finish a measured run with no samples', () => {
    const recorder = phaseRecorder('a-small-change');
    recorder.options.setup({}, 'run');
    expect(() => recorder.options.teardown({}, 'run')).toThrow(/no samples recorded/);
  });

  it(
    'the BenchResult fields reach the report written by vitest bench --outputJson',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'ckpt-bench-plumbing-'));
      try {
        await mkdir(path.join(root, 'bench', 'scenarios'), { recursive: true });
        for (const file of ['phases.ts', 'results.schema.ts']) {
          await copyFile(path.join(repoRoot, 'bench', file), path.join(root, 'bench', file));
        }
        await writeFile(
          path.join(root, 'bench', 'scenarios', 'e-noop.bench.ts'),
          [
            "import { bench, describe } from 'vitest';",
            "import { phaseRecorder, type PhaseDurations } from '../phases.js';",
            "import { PHASES } from '../results.schema.js';",
            "const recorder = phaseRecorder('e-noop');",
            "const phases = Object.fromEntries(PHASES.map((p, i) => [p, p === 'hash' ? null : i + 1])) as PhaseDurations;",
            "describe('plumbing (constant numbers, not a measurement)', () => {",
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

        const read = readBenchResults(JSON.parse(await readFile(out, 'utf8')));
        expectExactPhases(read);
        expect(read.results).toHaveLength(1);
        expect(read.results[0]?.result).toMatchObject({ scenario: 'e-noop', budgetMs: 100, p95Ms: 12 });
        expect(read.results[0]?.result.phases.indexUpdate).toBe(7);
        // A not-measured phase survives vitest's JSON report as null (not dropped, not 0).
        expect(read.results[0]?.result.phases.hash).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
