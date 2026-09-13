import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    // `npm test` runs unit (tests/unit/**) and integration (tests/integration/**) tests only.
    // The include glob is relative to the scan directory, so `vitest run --dir tests/e2e`
    // (`npm run test:e2e`) still finds the e2e suite, while a root-level run excludes it.
    // Playwright specs (`*.spec.ts`, run by `npm run test:ui`) never match.
    include: ['**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'bench/**'],
    // DEC-019(3): spawn-heavy tests (git, fsync) exceed the 5 s defaults on a loaded gate.
    testTimeout: 30000,
    hookTimeout: 30000,
    // `npm run bench` (mode "benchmark") exits 0 and writes an empty report ({"files": []}) until
    // the Performance Envelope scenarios exist. Benchmark mode only: `npm test` with no test files
    // still fails.
    passWithNoTests: mode === 'benchmark',
    benchmark: {
      // SPEC-001: `npm run bench` runs vitest bench over bench/scenarios/** (owned by SPEC-014).
      // p95 and per-phase timings come from bench/phases.ts, not from vitest's samples.
      include: ['bench/scenarios/**/*.bench.ts'],
    },
  },
}));
