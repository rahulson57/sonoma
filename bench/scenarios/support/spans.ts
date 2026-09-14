/**
 * DIAGNOSTIC merged spans for the SPEC-014 checkpoint scenarios (DEC-051(1)).
 *
 * Until the approved `phaseTimer` hook exists, two stretches of a checkpoint can only be timed as MERGED spans that
 * each cover several SPEC-002 phases. They are NOT phases and are never written under a phase key: the harness puts
 * their p95 in `unattributedP95Ms: {beforeStorage, storageToRef}` beside the BenchResult fields, as diagnostic
 * evidence for DEC-038 fix-forward work. bench:check never reads them.
 *
 * A span that was not measured is reported as nothing (null / field omitted), never as 0.
 */
import { percentile } from '../../phases.js';

/** The only merged spans a checkpoint scenario may report (DEC-051(1)). NOT SPEC-002 phases. */
export interface UnattributedSpans {
  /** checkpoint() call → createCheckpoint() call: changeDetection + scanRedact + hash + staging writes, merged. */
  beforeStorage: number;
  /** createCheckpoint() call → ref written: writer lock + git objects/tree/commit + state-blob CAS write + ref, merged. */
  storageToRef: number;
}

export const UNATTRIBUTED_SPANS = ['beforeStorage', 'storageToRef'] as const satisfies ReadonlyArray<keyof UnattributedSpans>;

/**
 * Nearest-rank p95 of each merged span over the measured samples, or null when there are no samples or ANY sample
 * carried no spans (a p95 over a subset would present a partial measurement as a whole one).
 * Throws on a span value that is missing, negative or not finite.
 */
export function unattributedP95(samples: ReadonlyArray<UnattributedSpans | null>): UnattributedSpans | null {
  if (samples.length === 0 || samples.some((s) => s === null)) return null;
  const measured = samples as ReadonlyArray<UnattributedSpans>;
  const p95Of = (span: keyof UnattributedSpans): number =>
    percentile(
      measured.map((sample) => {
        const value: unknown = sample[span];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new RangeError(`unattributedP95: ${span} must be a finite number >= 0, got ${String(value)}`);
        }
        return value;
      }),
      95,
    );
  return { beforeStorage: p95Of('beforeStorage'), storageToRef: p95Of('storageToRef') };
}
