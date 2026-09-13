/**
 * Budget gate over bench/results.json (SPEC-002 "Benchmark scenarios").
 *
 *   tsx bench/check-budgets.ts <results.json>     (npm run bench:check, via bench/check.ts)
 *
 * results.json is vitest's native benchmark report (`vitest bench --outputJson`). A scenario is
 * identified by its bench file name (bench/a-small-change.bench.ts → `a-small-change`). Every
 * benchmark entry is a scenario entry and must carry `phases` (all 7 phases, each
 * {mean, p95, max} in ms). Entries also carry a total `p95`; both are attached by
 * bench/phases.ts `phaseRecorder()`.
 *
 * Exit codes: 0 = every budgeted scenario present, well-formed and within budget;
 *             1 = a budgeted scenario is over budget, missing, or an entry is malformed;
 *             2 = usage error, or the results file cannot be read or parsed.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PHASES, type Phase } from './phases.js';

export type Budget =
  | { kind: 'totalP95'; maxMs: number }
  | { kind: 'totalMax'; maxMs: number }
  | { kind: 'phaseMax'; phase: Phase; maxMs: number }
  | { kind: 'reported' };

export interface Scenario {
  id: string;
  description: string;
  budget: Budget;
}

/** SPEC-002 benchmark table. Budgets are strict upper bounds ("p95 < 500 ms"). */
export const SCENARIOS: readonly Scenario[] = [
  { id: 'a-small-change', description: '2 GB workspace, 1 KB changed', budget: { kind: 'totalP95', maxMs: 500 } },
  { id: 'b-many-files', description: '100k files, 10 changed', budget: { kind: 'totalP95', maxMs: 500 } },
  { id: 'c-large-file', description: '500 MB file changed', budget: { kind: 'reported' } },
  {
    id: 'd-secret-output',
    description: '10 MB secret-heavy tool output (sanitize)',
    budget: { kind: 'phaseMax', phase: 'scanRedact', maxMs: 2000 },
  },
  { id: 'e-noop', description: 'no-op checkpoint', budget: { kind: 'totalP95', maxMs: 100 } },
  { id: 'f-initial', description: '2 GB initial snapshot', budget: { kind: 'totalMax', maxMs: 30_000 } },
];

export interface BenchmarkEntry {
  name: string;
  mean: number;
  max: number;
  p99?: number;
  p95?: number;
  phases?: unknown;
  [key: string]: unknown;
}

export interface BenchReport {
  files: Array<{ filepath: string; groups: Array<{ fullName: string; benchmarks: BenchmarkEntry[] }> }>;
}

export interface ScenarioEntry {
  scenarioId: string;
  label: string;
  entry: BenchmarkEntry;
}

export interface Evaluation {
  ok: boolean;
  lines: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDuration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const ms = (v: number): string => `${v.toFixed(1)} ms`;

export function scenarioIdOf(filepath: string): string {
  return path.basename(filepath).replace(/\.bench\.[cm]?[jt]s$/, '');
}

/** Structural problems in a results report; empty when the report is well-formed. */
export function validateReportShape(report: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(report) || !Array.isArray(report.files)) return ['report: expected an object with a "files" array'];
  report.files.forEach((file: unknown, fi: number) => {
    if (!isRecord(file) || typeof file.filepath !== 'string' || !Array.isArray(file.groups)) {
      errors.push(`files[${fi}]: expected {filepath: string, groups: []}`);
      return;
    }
    file.groups.forEach((group: unknown, gi: number) => {
      if (!isRecord(group) || typeof group.fullName !== 'string' || !Array.isArray(group.benchmarks)) {
        errors.push(`files[${fi}].groups[${gi}]: expected {fullName: string, benchmarks: []}`);
        return;
      }
      group.benchmarks.forEach((bench: unknown, bi: number) => {
        const where = `${scenarioIdOf(file.filepath as string)} > ${group.fullName} > ${isRecord(bench) ? String(bench.name) : `#${bi}`}`;
        if (!isRecord(bench) || typeof bench.name !== 'string') {
          errors.push(`${where}: expected a benchmark object with a name`);
          return;
        }
        for (const field of ['mean', 'max'] as const) {
          if (!isDuration(bench[field])) errors.push(`${where}: "${field}" must be a finite number >= 0`);
        }
        if (bench.p95 !== undefined && !isDuration(bench.p95)) errors.push(`${where}: "p95" must be a finite number >= 0`);
        if (!isRecord(bench.phases)) {
          errors.push(`${where}: missing "phases" (all of ${PHASES.join(', ')})`);
          return;
        }
        for (const phase of PHASES) {
          const stats = bench.phases[phase];
          if (!isRecord(stats)) {
            errors.push(`${where}: missing phase timing "${phase}"`);
            continue;
          }
          for (const stat of ['mean', 'p95', 'max'] as const) {
            if (!isDuration(stats[stat])) errors.push(`${where}: phases.${phase}.${stat} must be a finite number >= 0`);
          }
        }
      });
    });
  });
  return errors;
}

/** Every benchmark in the report, tagged with its scenario id. Assumes a well-formed report. */
export function scenarioEntries(report: BenchReport): ScenarioEntry[] {
  return report.files.flatMap((file) =>
    file.groups.flatMap((group) =>
      group.benchmarks.map((entry) => ({
        scenarioId: scenarioIdOf(file.filepath),
        label: `${group.fullName} > ${entry.name}`,
        entry,
      })),
    ),
  );
}

function phaseBreakdown(entry: BenchmarkEntry): string {
  const phases = entry.phases as Record<Phase, { mean: number; p95: number }>;
  const total = PHASES.reduce((sum, p) => sum + phases[p].mean, 0);
  const parts = PHASES.map((p) => {
    const share = total > 0 ? phases[p].mean / total : 0;
    return `${p} p95=${ms(phases[p].p95)}${share > 0.5 ? ' (dominant)' : ''}`;
  });
  return `      phases: ${parts.join(' | ')}`;
}

function measure(entry: BenchmarkEntry, budget: Exclude<Budget, { kind: 'reported' }>): { value: number | undefined; metric: string } {
  switch (budget.kind) {
    case 'totalP95':
      if (isDuration(entry.p95)) return { value: entry.p95, metric: 'p95' };
      return { value: isDuration(entry.p99) ? entry.p99 : undefined, metric: 'p99 (upper bound for p95; no p95 recorded)' };
    case 'totalMax':
      return { value: entry.max, metric: 'max' };
    case 'phaseMax': {
      const phases = entry.phases as Record<Phase, { max: number }>;
      return { value: phases[budget.phase].max, metric: `${budget.phase} max` };
    }
  }
}

/** Check every scenario's entries against its budget and render a report. */
export function evaluate(report: unknown): Evaluation {
  const shapeErrors = validateReportShape(report);
  if (shapeErrors.length > 0) {
    return { ok: false, lines: ['FAIL results file is malformed:', ...shapeErrors.map((e) => `  - ${e}`)] };
  }
  const entries = scenarioEntries(report as BenchReport);
  const lines: string[] = [];
  let ok = true;

  for (const scenario of SCENARIOS) {
    const own = entries.filter((e) => e.scenarioId === scenario.id);
    if (own.length === 0) {
      if (scenario.budget.kind === 'reported') {
        lines.push(`WARN ${scenario.id} (${scenario.description}): not in results (reported-only scenario)`);
      } else {
        ok = false;
        lines.push(`FAIL ${scenario.id} (${scenario.description}): missing from results (expected bench/${scenario.id}.bench.ts)`);
      }
      continue;
    }
    for (const { label, entry } of own) {
      const budget = scenario.budget;
      if (budget.kind === 'reported') {
        lines.push(`INFO ${scenario.id} [${label}]: mean ${ms(entry.mean)}, max ${ms(entry.max)} (reported, not budgeted)`);
      } else {
        const { value, metric } = measure(entry, budget);
        const pass = value !== undefined && value < budget.maxMs;
        if (!pass) ok = false;
        const shown = value === undefined ? 'no value' : ms(value);
        lines.push(`${pass ? 'PASS' : 'FAIL'} ${scenario.id} [${label}]: ${metric} ${shown} (budget < ${ms(budget.maxMs)})`);
      }
      lines.push(phaseBreakdown(entry));
    }
  }

  const known = new Set(SCENARIOS.map((s) => s.id));
  for (const id of new Set(entries.map((e) => e.scenarioId))) {
    if (!known.has(id)) lines.push(`INFO ${id}: not a SPEC-002 scenario; shape checked, no budget`);
  }
  lines.push(ok ? 'bench:check OK: all budgeted scenarios within budget' : 'bench:check FAILED');
  return { ok, lines };
}

export interface Io {
  log(line: string): void;
  error(line: string): void;
}

export function main(argv: readonly string[], io: Io = { log: console.log, error: console.error }): number {
  if (argv.length !== 1 || !argv[0]) {
    io.error('usage: check-budgets <results.json>');
    return 2;
  }
  const file = argv[0];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    io.error(`bench:check: cannot read ${file} (${(err as Error).message}); run \`npm run bench\` first`);
    return 2;
  }
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    io.error(`bench:check: ${file} is not valid JSON (${(err as Error).message})`);
    return 2;
  }
  const { ok, lines } = evaluate(report);
  for (const line of lines) (ok ? io.log : io.error)(line);
  return ok ? 0 : 1;
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === pathToFileURL(realpathSync(new URL(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
