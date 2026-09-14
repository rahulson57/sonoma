/**
 * SPEC-002: `tsx bench/check-budgets.ts --results <file>` exits non-zero and names the scenario for
 * the over-budget fixture, and exits 0 for the within-budget fixture. The CLI tests run the real
 * script through tsx, as `npm run bench:check` does.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, main } from '../../../bench/check-budgets.js';
import { BUDGETS, type BenchResult } from '../../../bench/results.schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const WITHIN_BUDGET = path.join(here, 'fixtures', 'within-budget.json');
const OVER_BUDGET = path.join(here, 'fixtures', 'over-budget.json');
/** within-budget.json with e-noop's scanRedact and gitCommit null (not measured); its p95 is still within budget. */
const NOT_MEASURED = path.join(here, 'fixtures', 'not-measured.json');
/** within-budget.json with every d-secret-output phase but scanRedact null; every budgeted scenario fully measured. */
const NULL_BUDGET_UNMEASURED = path.join(here, 'fixtures', 'null-budget-unmeasured.json');
const CLI_TIMEOUT_MS = 30_000;

type Entry = BenchResult & Record<string, unknown>;
interface NativeReport {
  files: Array<{ filepath: string; groups: Array<{ fullName: string; benchmarks: Entry[] }> }>;
}

const load = (file: string = WITHIN_BUDGET): NativeReport => JSON.parse(readFileSync(file, 'utf8')) as NativeReport;
const entries = (report: NativeReport): Entry[] => report.files.flatMap((f) => f.groups.flatMap((g) => g.benchmarks));

function entryOf(report: NativeReport, scenario: string): Entry {
  const entry = entries(report).find((e) => e.scenario === scenario);
  if (!entry) throw new Error(`fixture has no entry for ${scenario}`);
  return entry;
}

const BUDGETED = Object.entries(BUDGETS).filter((e): e is [string, number] => e[1] !== null);
const quiet = { log: () => {}, error: () => {} };

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [tsxCli, path.join(repoRoot, 'bench', 'check-budgets.ts'), ...args], { cwd: repoRoot }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ckpt-check-budgets-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('check-budgets CLI', () => {
  it('is exactly what `npm run bench:check` runs', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['bench:check']).toBe('tsx bench/check-budgets.ts --results bench/results.json');
  });

  it(
    'exits 0 for the within-budget fixture',
    async () => {
      const { code, stdout } = await runCli(['--results', WITHIN_BUDGET]);
      expect(code).toBe(0);
      for (const [scenario] of BUDGETED) expect(stdout).toContain(`PASS ${scenario}`);
      expect(stdout).toContain('INFO d-secret-output');
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'exits non-zero for the over-budget fixture and names the over-budget scenario',
    async () => {
      const { code, stderr } = await runCli(['--results', OVER_BUDGET]);
      expect(code).toBe(1);
      expect(stderr).toMatch(/FAIL a-small-change .*p95 612\.4 ms is over budget 500\.0 ms/);
      expect(stderr).toContain('bench:check FAILED: a-small-change');
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'exits 1 for a budgeted scenario with a null phase, naming the scenario and the phase, although its p95 is within budget',
    async () => {
      const { code, stderr } = await runCli(['--results', NOT_MEASURED]);
      expect(code).toBe(1);
      expect(stderr).toContain('NOT MEASURED e-noop: scanRedact, gitCommit');
      expect(stderr).not.toContain('PASS e-noop');
      expect(stderr).toContain('bench:check FAILED: e-noop');
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'exits 0 when only the reported-only scenario has null phases',
    async () => {
      const { code, stdout } = await runCli(['--results', NULL_BUDGET_UNMEASURED]);
      expect(code).toBe(0);
      expect(stdout).toMatch(
        /INFO d-secret-output .*reported, not budgeted; not measured: changeDetection, hash, blobWrite, gitCommit, ledgerAppend, indexUpdate/,
      );
      expect(stdout).not.toContain('NOT MEASURED');
      for (const [scenario] of BUDGETED) expect(stdout).toContain(`PASS ${scenario}`);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'exits 2 when the results file is missing or not JSON',
    async () => {
      expect((await runCli(['--results', path.join(tmp, 'does-not-exist.json')])).code).toBe(2);
      const bad = path.join(tmp, 'bad.json');
      await writeFile(bad, '{ not json');
      expect((await runCli(['--results', bad])).code).toBe(2);
    },
    CLI_TIMEOUT_MS,
  );

  it('rejects anything but `--results <path>` as a usage error', () => {
    const errors: string[] = [];
    const io = { log: () => {}, error: (l: string) => errors.push(l) };
    expect(main([], io)).toBe(2);
    expect(main([WITHIN_BUDGET], io)).toBe(2);
    expect(main(['--results'], io)).toBe(2);
    expect(main(['--result', WITHIN_BUDGET], io)).toBe(2);
    expect(main(['--results', WITHIN_BUDGET, 'extra'], io)).toBe(2);
    expect(errors.every((l) => l.includes('--results'))).toBe(true);
    expect(main(['--results', WITHIN_BUDGET], quiet)).toBe(0);
  });
});

describe('evaluate()', () => {
  it('passes the within-budget fixture', () => {
    const result = evaluate(load());
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(result).toMatchObject({ ok: true, failed: [] });
  });

  it.each(BUDGETED)('fails %s when p95Ms is over its %d ms budget', (scenario, budget) => {
    const report = load();
    entryOf(report, scenario).p95Ms = budget + 0.1;
    const result = evaluate(report);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([scenario]);
    expect(result.lines.some((l) => l.startsWith(`FAIL ${scenario} `) && l.includes('over budget'))).toBe(true);
  });

  it.each(BUDGETED)('fails %s as NOT MEASURED when any phase is null, whatever its p95Ms', (scenario) => {
    const report = load();
    const entry = entryOf(report, scenario);
    entry.p95Ms = 0.1;
    (entry.phases as Record<string, number | null>).ledgerAppend = null;
    const result = evaluate(report);
    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([scenario]);
    expect(result.lines).toContain(`NOT MEASURED ${scenario}: ledgerAppend`);
    expect(result.lines.some((l) => l.startsWith(`PASS ${scenario} `))).toBe(false);
  });

  it('reports both NOT MEASURED and over budget when both hold', () => {
    const report = load();
    const entry = entryOf(report, 'e-noop');
    entry.p95Ms = 150;
    (entry.phases as Record<string, number | null>).hash = null;
    const result = evaluate(report);
    expect(result.failed).toEqual(['e-noop']);
    expect(result.lines).toContain('NOT MEASURED e-noop: hash');
    expect(result.lines).toContainEqual(expect.stringMatching(/^FAIL e-noop .*p95 150\.0 ms is over budget 100\.0 ms/));
  });

  it('judges no phase dominant while any phase of the entry is not measured', () => {
    const report = load();
    (entryOf(report, 'b-many-files').phases as Record<string, number | null>).indexUpdate = null;
    const lines = evaluate(report).lines;
    const b = lines.indexOf(lines.find((l) => l.startsWith('FAIL b-many-files'))!);
    expect(lines[b + 1]).toContain('changeDetection 238.6 ms |');
    expect(lines[b + 1]).toContain('indexUpdate not measured');
    expect(lines[b + 1]).not.toContain('(dominant)');
  });

  it('fails only when p95Ms > budgetMs: exactly at budget passes', () => {
    const report = load();
    for (const [scenario, budget] of BUDGETED) entryOf(report, scenario).p95Ms = budget;
    expect(evaluate(report).ok).toBe(true);
  });

  it('reports but never fails the unbudgeted d-secret-output scenario', () => {
    const report = load();
    entryOf(report, 'd-secret-output').p95Ms = 999_999;
    const result = evaluate(report);
    expect(result.ok).toBe(true);
    expect(result.lines).toContainEqual(expect.stringMatching(/^INFO d-secret-output .*reported, not budgeted/));
    expect(result.lines.join('\n')).toMatch(/scanRedact 1288\.4 ms \(dominant\)/);
  });

  it('fails when a budgeted scenario is missing, but only warns for a reported-only one', () => {
    const withoutNoop = load();
    withoutNoop.files = withoutNoop.files.filter((f) => !f.filepath.endsWith('/e-noop.bench.ts'));
    const missing = evaluate(withoutNoop);
    expect(missing.failed).toEqual(['e-noop']);
    expect(missing.lines).toContainEqual(expect.stringMatching(/^FAIL e-noop: missing from results/));

    const withoutSecretOutput = load();
    withoutSecretOutput.files = withoutSecretOutput.files.filter((f) => !f.filepath.endsWith('/d-secret-output.bench.ts'));
    const warned = evaluate(withoutSecretOutput);
    expect(warned.ok).toBe(true);
    expect(warned.lines).toContainEqual(expect.stringMatching(/^WARN d-secret-output/));

    expect(evaluate({ files: [] }).failed.sort()).toEqual(BUDGETED.map(([s]) => s).sort());
  });

  it('fails an entry whose budgetMs disagrees with the SPEC-002 budget table', () => {
    const loosened = load();
    entryOf(loosened, 'e-noop').budgetMs = 250;
    expect(evaluate(loosened).failed).toEqual(['e-noop']);

    const budgeted = load();
    entryOf(budgeted, 'd-secret-output').budgetMs = 5000;
    expect(evaluate(budgeted).failed).toEqual(['d-secret-output']);
  });

  it('marks a phase that dominates the total', () => {
    const lines = evaluate(load()).lines;
    const b = lines.indexOf(lines.find((l) => l.startsWith('PASS b-many-files'))!);
    expect(lines[b + 1]).toContain('changeDetection 238.6 ms (dominant)');
    expect(lines[b + 1]?.match(/\(dominant\)/g)).toHaveLength(1);
  });

  it('accepts a bare BenchResult[] as well as the vitest report', () => {
    const bare = (report: NativeReport): BenchResult[] =>
      entries(report).map(({ scenario, budgetMs, p95Ms, phases }) => ({ scenario, budgetMs, p95Ms, phases }));
    expect(evaluate(bare(load())).ok).toBe(true);
    expect(evaluate(bare(load(OVER_BUDGET))).failed).toEqual(['a-small-change']);
  });

  it('applies no budget to a scenario outside the table', () => {
    const report = load();
    const extra = { ...entryOf(report, 'e-noop'), scenario: 'x-exploratory', budgetMs: 1, p95Ms: 50 };
    report.files[0]!.groups[0]!.benchmarks.push(extra);
    const result = evaluate(report);
    expect(result.ok).toBe(true);
    expect(result.lines).toContainEqual(expect.stringMatching(/^INFO x-exploratory .*no budget applied/));
  });

  it('fails a malformed report', () => {
    const report = load();
    delete (entryOf(report, 'b-many-files').phases as Partial<BenchResult['phases']>).gitCommit;
    const result = evaluate(report);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/b-many-files.*missing phase timing "gitCommit"/);
    expect(evaluate({ nope: true }).ok).toBe(false);
    expect(main(['--results', path.join(tmp, 'never-written.json')], quiet)).toBe(2);
  });
});
