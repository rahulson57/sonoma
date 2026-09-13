/**
 * SPEC-002 results format: the `BenchResult` every benchmark scenario reports, the budget table,
 * and the reader that pulls BenchResults out of bench/results.json.
 *
 * `npm run bench` is exactly `vitest bench --run --outputJson bench/results.json` (SPEC-001), so
 * the file is vitest's native report: `{ files: [{ filepath, groups: [{ fullName, benchmarks }] }] }`.
 * Each benchmark entry carries the BenchResult fields (scenario, budgetMs, p95Ms, phases) next to
 * vitest's own statistics. bench/phases.ts `phaseRecorder()` attaches them. `readBenchResults()`
 * also accepts a bare `BenchResult[]`.
 */

/** The 7 checkpoint phases, exactly (SPEC-002 "Measurement definition"). */
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

/** Per-phase latency in milliseconds (the phase's p95 over the measured iterations). */
export type PhaseTimings = Record<Phase, number>;

export interface BenchResult {
  /** Scenario id, e.g. "a-small-change". */
  scenario: string;
  /** null = reported, not budgeted. */
  budgetMs: number | null;
  /** `checkpoint()` call to ACK, p95 over the measured iterations, in milliseconds. */
  p95Ms: number;
  phases: PhaseTimings;
}

/**
 * SPEC-002 budget table, keyed by scenario id (the scenarios themselves belong to SPEC-014).
 * Scenarios never define budgets: phaseRecorder() copies budgetMs from here, and
 * bench/check-budgets.ts rejects an entry whose budgetMs disagrees with it.
 */
export const BUDGETS: Readonly<Record<string, number | null>> = Object.freeze({
  'a-small-change': 500, // 2 GB workspace, 1 KB changed: incremental ack p95 < 500 ms
  'b-many-files': 500, // 100k files, 10 changed: incremental ack p95 < 500 ms
  'd-secret-output': null, // 10 MB secret-heavy tool output: scanRedact reported
  'e-noop': 100, // no-op checkpoint: p95 < 100 ms
  'f-initial': 30_000, // 2 GB initial snapshot: < 30 s
});

export function isKnownScenario(id: string): boolean {
  return Object.hasOwn(BUDGETS, id);
}

/** A BenchResult plus where it was found in the report, for messages. */
export interface LocatedResult {
  where: string;
  result: BenchResult;
}

export interface ReadResults {
  results: LocatedResult[];
  /** Structural problems; when non-empty, `results` holds only the well-formed entries. */
  errors: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDuration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Problems with one BenchResult-shaped value; empty when it is well-formed. */
export function validateBenchResult(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where}: expected a BenchResult object`];
  const errors: string[] = [];
  if (typeof value.scenario !== 'string' || value.scenario === '') errors.push(`${where}: "scenario" must be a non-empty string`);
  if (value.budgetMs !== null && !isDuration(value.budgetMs)) errors.push(`${where}: "budgetMs" must be null or a finite number >= 0`);
  if (!isDuration(value.p95Ms)) errors.push(`${where}: "p95Ms" must be a finite number >= 0`);
  if (!isRecord(value.phases)) {
    errors.push(`${where}: missing "phases" (exactly ${PHASES.join(', ')})`);
    return errors;
  }
  for (const phase of PHASES) {
    if (!(phase in value.phases)) errors.push(`${where}: missing phase timing "${phase}"`);
    else if (!isDuration(value.phases[phase])) errors.push(`${where}: phases.${phase} must be a finite number >= 0`);
  }
  const known = new Set<string>(PHASES);
  for (const key of Object.keys(value.phases)) {
    if (!known.has(key)) errors.push(`${where}: unexpected phase key "${key}"`);
  }
  return errors;
}

function collect(value: unknown, where: string, out: ReadResults): void {
  const errors = validateBenchResult(value, where);
  if (errors.length > 0) {
    out.errors.push(...errors);
    return;
  }
  const r = value as BenchResult;
  out.results.push({
    where,
    result: { scenario: r.scenario, budgetMs: r.budgetMs, p95Ms: r.p95Ms, phases: { ...r.phases } },
  });
}

/** Every BenchResult in a results report (vitest's native report or a bare BenchResult[]). */
export function readBenchResults(report: unknown): ReadResults {
  const out: ReadResults = { results: [], errors: [] };
  if (Array.isArray(report)) {
    report.forEach((value, i) => collect(value, `[${i}]`, out));
    return out;
  }
  if (!isRecord(report) || !Array.isArray(report.files)) {
    out.errors.push('report: expected vitest\'s benchmark report ({"files": [...]}) or a BenchResult array');
    return out;
  }
  report.files.forEach((file: unknown, fi: number) => {
    if (!isRecord(file) || typeof file.filepath !== 'string' || !Array.isArray(file.groups)) {
      out.errors.push(`files[${fi}]: expected {filepath: string, groups: []}`);
      return;
    }
    file.groups.forEach((group: unknown, gi: number) => {
      if (!isRecord(group) || typeof group.fullName !== 'string' || !Array.isArray(group.benchmarks)) {
        out.errors.push(`files[${fi}].groups[${gi}]: expected {fullName: string, benchmarks: []}`);
        return;
      }
      group.benchmarks.forEach((entry: unknown, bi: number) => {
        const name = isRecord(entry) && typeof entry.name === 'string' ? entry.name : `#${bi}`;
        collect(entry, `${group.fullName} > ${name}`, out);
      });
    });
  });
  return out;
}
