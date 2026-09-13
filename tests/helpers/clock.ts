/**
 * Injected time for tests (SPEC-001 "Determinism": no test depends on wall-clock ordering).
 *
 * A fixed clock never reads `Date.now()` or `performance.now()`; it advances only when the
 * test calls `tick()`.
 */

export interface FixedClock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Advance the clock by `ms` (finite, >= 0). */
  tick(ms: number): void;
}

export function fixedClock(startMs: number): FixedClock {
  if (!Number.isFinite(startMs)) {
    throw new TypeError(`fixedClock: startMs must be a finite number, got ${String(startMs)}`);
  }
  let current = startMs;
  return {
    now: () => current,
    tick(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`fixedClock.tick: ms must be a finite number >= 0, got ${String(ms)}`);
      }
      current += ms;
    },
  };
}
