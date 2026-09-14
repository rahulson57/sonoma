/**
 * Budget gate over bench/results.json (SPEC-002 "Results format and budget checker").
 *
 *   tsx bench/check-budgets.ts --results bench/results.json      (npm run bench:check)
 *
 * Reads every BenchResult (bench/results.schema.ts) and checks it against the SPEC-002 budget table:
 *   - a budgeted scenario fails when p95Ms > budgetMs;
 *   - a budgeted scenario with ANY phase `null` (not measured) fails with `NOT MEASURED <scenario>: <phases>`,
 *     whatever its p95Ms: an unmeasured phase is never a pass (DEC-049(1), DEC-050(3));
 *   - a budgeted scenario missing from the results fails, because an unmeasured envelope is not a pass;
 *   - an entry whose budgetMs differs from the table fails, because scenarios never define budgets;
 *   - scenarios with budgetMs null (d-secret-output) are reported with their phases, nulls included, never failed.
 * Every line names its scenario. The per-phase breakdown marks a phase that dominates the total.
 *
 * Exit codes: 0 = every budgeted scenario is present, fully measured and within budget;
 *             1 = a scenario is over budget, not fully measured, missing, has a mismatched budget, or results
 *                 are malformed;
 *             2 = usage error, or the results file cannot be read or parsed.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BUDGETS, isKnownScenario, PHASES, readBenchResults, unmeasuredPhases, type BenchResult } from './results.schema.js';

export interface Evaluation {
  ok: boolean;
  /** Scenario ids that failed the gate. */
  failed: string[];
  lines: string[];
}

const ms = (v: number): string => `${v.toFixed(1)} ms`;
const budgetText = (v: number | null): string => (v === null ? 'null (reported)' : ms(v));

function phaseBreakdown(result: BenchResult): string {
  const unmeasured = unmeasuredPhases(result);
  // With a phase unmeasured the measured sum is not the whole, so no phase can be called dominant.
  const total = unmeasured.length > 0 ? 0 : PHASES.reduce((sum, p) => sum + (result.phases[p] ?? 0), 0);
  const parts = PHASES.map((p) => {
    const value = result.phases[p];
    if (value === null) return `${p} not measured`;
    const dominant = total > 0 && value / total > 0.5;
    return `${p} ${ms(value)}${dominant ? ' (dominant)' : ''}`;
  });
  return `      phases (p95): ${parts.join(' | ')}`;
}

/** Check every BenchResult in a results report against the SPEC-002 budget table. */
export function evaluate(report: unknown): Evaluation {
  const { results, errors } = readBenchResults(report);
  if (errors.length > 0) {
    return { ok: false, failed: [], lines: ['FAIL results file is malformed:', ...errors.map((e) => `  - ${e}`), 'bench:check FAILED'] };
  }

  const lines: string[] = [];
  const failed = new Set<string>();

  for (const { where, result } of results) {
    const { scenario, budgetMs, p95Ms } = result;
    const label = `${scenario} [${where}]`;
    const unmeasured = unmeasuredPhases(result);
    if (!isKnownScenario(scenario)) {
      lines.push(`INFO ${label}: not a SPEC-002 scenario; p95 ${ms(p95Ms)}, no budget applied`);
    } else {
      const expected = BUDGETS[scenario] ?? null;
      if (budgetMs !== expected) {
        failed.add(scenario);
        lines.push(`FAIL ${label}: budgetMs ${budgetText(budgetMs)} does not match the SPEC-002 budget ${budgetText(expected)}`);
      } else if (expected === null) {
        const note = unmeasured.length > 0 ? `; not measured: ${unmeasured.join(', ')}` : '';
        lines.push(`INFO ${label}: p95 ${ms(p95Ms)} (reported, not budgeted)${note}`);
      } else {
        if (unmeasured.length > 0) {
          failed.add(scenario);
          lines.push(`NOT MEASURED ${scenario}: ${unmeasured.join(', ')}`);
        }
        if (p95Ms > expected) {
          failed.add(scenario);
          lines.push(`FAIL ${label}: p95 ${ms(p95Ms)} is over budget ${ms(expected)}`);
        } else if (unmeasured.length > 0) {
          lines.push(`FAIL ${label}: p95 ${ms(p95Ms)} is within budget ${ms(expected)}, but not a pass while phases are not measured`);
        } else {
          lines.push(`PASS ${label}: p95 ${ms(p95Ms)} within budget ${ms(expected)}`);
        }
      }
    }
    lines.push(phaseBreakdown(result));
  }

  const present = new Set(results.map((r) => r.result.scenario));
  for (const [scenario, budget] of Object.entries(BUDGETS)) {
    if (present.has(scenario)) continue;
    if (budget === null) {
      lines.push(`WARN ${scenario}: not in results (reported-only scenario)`);
    } else {
      failed.add(scenario);
      lines.push(`FAIL ${scenario}: missing from results (expected bench/scenarios/${scenario}.bench.ts)`);
    }
  }

  const ok = failed.size === 0;
  lines.push(
    ok ? 'bench:check OK: every budgeted scenario is fully measured and within budget' : `bench:check FAILED: ${[...failed].join(', ')}`,
  );
  return { ok, failed: [...failed], lines };
}

export interface Io {
  log(line: string): void;
  error(line: string): void;
}

const USAGE = 'usage: check-budgets --results <results.json>';

export function main(argv: readonly string[], io: Io = { log: console.log, error: console.error }): number {
  if (argv.length !== 2 || argv[0] !== '--results' || !argv[1]) {
    io.error(USAGE);
    return 2;
  }
  const file = argv[1];
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
