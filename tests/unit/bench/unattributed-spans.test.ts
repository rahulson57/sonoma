/**
 * DEC-051(1): the scenarios' merged spans are DIAGNOSTIC. They are reported only as
 * `unattributedP95Ms: {beforeStorage, storageToRef}` beside the BenchResult fields, never under a phase key,
 * and a span that was not measured is never reported as 0.
 */
import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../bench/results.schema.js';
import { UNATTRIBUTED_SPANS, unattributedP95, type UnattributedSpans } from '../../../bench/scenarios/support/spans.js';

describe('unattributed merged spans', () => {
  it('are exactly the two approved spans, neither of which is a SPEC-002 phase key', () => {
    expect([...UNATTRIBUTED_SPANS]).toEqual(['beforeStorage', 'storageToRef']);
    for (const span of UNATTRIBUTED_SPANS) expect((PHASES as readonly string[]).includes(span), span).toBe(false);
  });

  it('reports the nearest-rank p95 of each span, with exactly the approved keys', () => {
    const samples = Array.from({ length: 20 }, (_, i) => ({ beforeStorage: i + 1, storageToRef: (i + 1) * 10 }));
    const p95 = unattributedP95(samples);
    expect(p95).toEqual({ beforeStorage: 19, storageToRef: 190 });
    expect(Object.keys(p95 ?? {}).sort()).toEqual([...UNATTRIBUTED_SPANS].sort());
  });

  it('reports nothing (null), never 0, when there are no samples or any sample carried no spans', () => {
    expect(unattributedP95([])).toBeNull();
    expect(unattributedP95([null])).toBeNull();
    expect(unattributedP95([{ beforeStorage: 1, storageToRef: 2 }, null])).toBeNull();
  });

  it('rejects a missing, negative or non-finite span value instead of defaulting it', () => {
    for (const bad of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sample = { beforeStorage: 1, storageToRef: bad } as unknown as UnattributedSpans;
      expect(() => unattributedP95([sample]), String(bad)).toThrow(/storageToRef must be a finite number >= 0/);
    }
  });
});
