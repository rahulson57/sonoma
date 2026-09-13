/**
 * SPEC-002: bench/check-budgets.ts exits 1 when fed a fixture results file with an over-budget
 * scenario, and 0 when every budgeted scenario is within budget. The CLI tests run the real
 * script through tsx, the same way `npm run bench:check` does.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, main, SCENARIOS, type BenchReport } from '../../../bench/check-budgets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const WITHIN_BUDGET = path.join(here, 'fixtures', 'bench-results.within-budget.json');
const CLI_TIMEOUT_MS = 30_000;

const loadFixture = (): BenchReport => JSON.parse(readFileSync(WITHIN_BUDGET, 'utf8')) as BenchReport;

function entryOf(report: BenchReport, scenarioId: string) {
  const file = report.files.find((f) => path.basename(f.filepath) === `${scenarioId}.bench.ts`);
  const entry = file?.groups[0]?.benchmarks[0];
  if (!entry) throw new Error(`fixture has no entry for ${scenarioId}`);
  return entry;
}

async function runScript(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [tsxCli, path.join(repoRoot, 'bench', script), ...args], { cwd: repoRoot }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

let tmp: string;
const writeReport = async (name: string, report: unknown): Promise<string> => {
  const file = path.join(tmp, name);
  await writeFile(file, JSON.stringify(report));
  return file;
};

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ckpt-check-budgets-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('check-budgets CLI', () => {
  it(
    'exits 0 for the within-budget fixture',
    async () => {
      const { code, stdout } = await runScript('check-budgets.ts', [WITHIN_BUDGET]);
      expect(code).toBe(0);
      for (const s of SCENARIOS.filter((x) => x.budget.kind !== 'reported')) expect(stdout).toContain(`PASS ${s.id}`);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'exits 1 for a fixture with an over-budget scenario',
    async () => {
      const report = loadFixture();
      entryOf(report, 'a-small-change').p95 = 612.4;
      const { code, stderr } = await runScript('check-budgets.ts', [await writeReport('over-budget.json', report)]);
      expect(code).toBe(1);
      expect(stderr).toMatch(/FAIL a-small-change .*p95 612\.4 ms/);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'check.ts (the npm run bench:check entry) forwards to the same gate',
    async () => {
      const report = loadFixture();
      entryOf(report, 'e-noop').p95 = 140;
      expect((await runScript('check.ts', [await writeReport('over-e.json', report)])).code).toBe(1);
      expect((await runScript('check.ts', [WITHIN_BUDGET])).code).toBe(0);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'exits 2 on usage errors and unreadable results',
    async () => {
      expect((await runScript('check-budgets.ts', [])).code).toBe(2);
      expect((await runScript('check-budgets.ts', [path.join(tmp, 'does-not-exist.json')])).code).toBe(2);
      const bad = path.join(tmp, 'bad.json');
      await writeFile(bad, '{ not json');
      expect((await runScript('check-budgets.ts', [bad])).code).toBe(2);
    },
    CLI_TIMEOUT_MS,
  );
});

describe('evaluate()', () => {
  const quiet = { log: () => {}, error: () => {} };

  it('passes the within-budget fixture', () => {
    const result = evaluate(loadFixture());
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a-small-change', (r: BenchReport) => (entryOf(r, 'a-small-change').p95 = 500)],
    ['b-many-files', (r: BenchReport) => (entryOf(r, 'b-many-files').p95 = 731)],
    ['e-noop', (r: BenchReport) => (entryOf(r, 'e-noop').p95 = 100)],
    ['f-initial', (r: BenchReport) => (entryOf(r, 'f-initial').max = 30_000)],
    [
      'd-secret-output',
      (r: BenchReport) => ((entryOf(r, 'd-secret-output').phases as Record<string, { max: number }>).scanRedact!.max = 2000.5),
    ],
  ])('fails when %s is at or over its budget', (scenarioId, mutate) => {
    const report = loadFixture();
    mutate(report);
    const result = evaluate(report);
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.startsWith(`FAIL ${scenarioId}`))).toBe(true);
  });

  it('does not budget the reported-only large-file scenario', () => {
    const report = loadFixture();
    const c = entryOf(report, 'c-large-file');
    c.p95 = 999_999;
    c.max = 999_999;
    expect(evaluate(report).ok).toBe(true);
  });

  it('fails when a budgeted scenario is missing, but only warns for reported-only ones', () => {
    const withoutNoop = loadFixture();
    withoutNoop.files = withoutNoop.files.filter((f) => !f.filepath.endsWith('e-noop.bench.ts'));
    const missing = evaluate(withoutNoop);
    expect(missing.ok).toBe(false);
    expect(missing.lines.some((l) => l.startsWith('FAIL e-noop') && l.includes('missing'))).toBe(true);

    const withoutLargeFile = loadFixture();
    withoutLargeFile.files = withoutLargeFile.files.filter((f) => !f.filepath.endsWith('c-large-file.bench.ts'));
    expect(evaluate(withoutLargeFile).ok).toBe(true);

    expect(main([path.join(tmp, 'never-written.json')], quiet)).toBe(2);
  });

  it('falls back to p99 as a conservative bound when no p95 was recorded', () => {
    const over = loadFixture();
    const a = entryOf(over, 'a-small-change');
    delete a.p95;
    a.p99 = 700;
    expect(evaluate(over).ok).toBe(false);

    const under = loadFixture();
    const a2 = entryOf(under, 'a-small-change');
    delete a2.p95;
    a2.p99 = 420;
    expect(evaluate(under).ok).toBe(true);
  });

  it('fails a malformed report', () => {
    const report = loadFixture();
    delete (entryOf(report, 'b-many-files').phases as Record<string, unknown>).gitCommit;
    const result = evaluate(report);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/b-many-files.*missing phase timing "gitCommit"/);
    expect(evaluate({ nope: true }).ok).toBe(false);
  });
});
