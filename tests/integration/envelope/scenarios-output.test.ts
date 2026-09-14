/**
 * SPEC-014 acceptance: `npm run bench` writes bench/results.json containing exactly the scenario ids a-small-change,
 * b-many-files, d-secret-output, e-noop and f-initial, each with the SPEC-002 `phases` shape.
 *
 * Two parts, so a fresh clone (no results file: it is gitignored and only `npm run bench` writes it) still checks
 * something real:
 * - Always: the scenario directory holds exactly those five scenario benches, and each one records under its own file
 *   name (`const SCENARIO = '<id>'` passed to phaseRecorder). The scenarios are never run here: SPEC-014 keeps them
 *   out of `npm test`.
 * - When the results file exists: vitest's report holds exactly one BenchResult per scenario file, the entry's
 *   `scenario` is that file's id, the id set is exactly the five, `budgetMs` is the SPEC-002 table's, and `phases` has
 *   exactly the 7 SPEC-002 keys, each a finite, non-negative timing or null for a phase the harness cannot measure
 *   (never 0; DEC-049(1), DEC-050). Scenario D reports scanRedact.
 *
 * Test titles avoid the literal scenario directory path: tests/unit/harness/vitest-config.test.ts greps `vitest list`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUDGETS, PHASES, readBenchResults } from '../../../bench/results.schema.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCENARIO_DIR = path.join(repoRoot, 'bench', 'scenarios');
const RESULTS = path.join(repoRoot, 'bench', 'results.json');
const BENCH_SUFFIX = '.bench.ts';

/** SPEC-014's scenario table, stated independently of bench/results.schema.ts. */
const EXPECTED_IDS = ['a-small-change', 'b-many-files', 'd-secret-output', 'e-noop', 'f-initial'];

const idOf = (file: string): string => path.basename(file).slice(0, -BENCH_SUFFIX.length);

interface ReportFile {
  filepath: string;
  groups: unknown[];
}

describe('SPEC-014 scenario set', () => {
  it('SPEC-014 and the SPEC-002 budget table name the same five scenarios', () => {
    expect(Object.keys(BUDGETS).sort()).toEqual(EXPECTED_IDS);
  });

  it('the scenario directory holds exactly the five scenario benches, each recording under its own id', () => {
    const benches = readdirSync(SCENARIO_DIR, { recursive: true, encoding: 'utf8' })
      .filter((rel) => rel.endsWith(BENCH_SUFFIX))
      .sort();
    expect(benches).toEqual(EXPECTED_IDS.map((id) => `${id}${BENCH_SUFFIX}`));

    for (const rel of benches) {
      const source = readFileSync(path.join(SCENARIO_DIR, rel), 'utf8');
      const declared = [...source.matchAll(/\bconst SCENARIO = '([^']+)'/g)].map((m) => m[1]);
      expect(declared, rel).toEqual([idOf(rel)]);
      expect(source, rel).toMatch(/\bphaseRecorder\(SCENARIO\)/);
    }
  });

  it.runIf(existsSync(RESULTS))('the results file from npm run bench holds exactly one SPEC-002 BenchResult per scenario', () => {
    const report = JSON.parse(readFileSync(RESULTS, 'utf8')) as { files?: ReportFile[] };
    expect(Array.isArray(report.files)).toBe(true);
    const files = report.files ?? [];

    // Every entry in the whole report is well-formed, and there are exactly five of them.
    const all = readBenchResults(report);
    expect(all.errors).toEqual([]);
    expect(all.results).toHaveLength(EXPECTED_IDS.length);

    const seen: string[] = [];
    for (const file of files) {
      expect(file.filepath.endsWith(BENCH_SUFFIX), file.filepath).toBe(true);
      const id = idOf(file.filepath);
      const { results, errors } = readBenchResults({ files: [file] });
      expect(errors, id).toEqual([]);
      expect(results, id).toHaveLength(1);
      const result = results[0]!.result;

      expect(result.scenario, id).toBe(id);
      expect(result.budgetMs, id).toBe(BUDGETS[id]);
      expect(Object.keys(result.phases).sort(), id).toEqual([...PHASES].sort());
      for (const phase of PHASES) {
        // A phase the harness cannot measure is null, never 0 (DEC-049(1), DEC-050).
        const value = result.phases[phase];
        expect(value === null || (Number.isFinite(value) && value >= 0), `${id} ${phase}`).toBe(true);
      }
      // SPEC-014: scenario D reports its scanRedact phase.
      if (id === 'd-secret-output') expect(result.phases.scanRedact, id).not.toBeNull();
      // A real call-to-ACK measurement is never zero.
      expect(result.p95Ms, id).toBeGreaterThan(0);
      seen.push(id);
    }
    expect(seen.sort()).toEqual(EXPECTED_IDS);
  });
});
