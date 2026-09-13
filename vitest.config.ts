import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `npm test` runs unit (tests/unit/**) and integration (tests/integration/**) tests only.
    // The include glob is relative to the scan directory, so `vitest run --dir tests/e2e`
    // (`npm run test:e2e`) still finds the e2e suite, while a root-level run excludes it.
    // Playwright specs (`*.spec.ts`, run by `npm run test:ui`) never match.
    include: ['**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'bench/**'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
      // Raw per-iteration samples in bench/results.json so bench:check can compute p95
      // (vitest's summary only reports p75/p99).
      includeSamples: true,
    },
  },
});
