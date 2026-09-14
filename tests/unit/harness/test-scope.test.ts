/**
 * SPEC-014: `npm test` collects no file under the benchmark scenario directory (bench/scenarios/). The scenarios
 * run only under `npm run bench`.
 *
 * Checked two ways, with the repository's own vitest config (`vitest list --filesOnly --json`, which is what
 * `npm test` = `vitest run` collects):
 * - the real repository: no collected path starts with the scenario prefix, and the run still collects real tests;
 * - a sentinel tree that plants a `.test.ts` (which the include glob would otherwise match) and a `.bench.ts` under
 *   the scenario prefix, next to a unit test that must still be collected.
 * A path counts only when its repository-relative path STARTS with the prefix: tests/unit/bench/ must be collected.
 * The prefix is built at runtime, as in tests/unit/harness/vitest-config.test.ts, so a test title never names the
 * literal directory path in `vitest list` output.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const TIMEOUT_MS = 60_000;
const SCENARIO_PREFIX = ['bench', 'scenarios', ''].join('/');

/** Test files `npm test` collects under `root` with the repository config: relative, POSIX-style, sorted. */
async function collectedFiles(root: string): Promise<string[]> {
  // Drop the parent run's worker variables so the child behaves like a top-level `npx vitest list`.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
  const { stdout } = await execFileAsync(
    process.execPath,
    [vitestCli, 'list', '--filesOnly', '--json', '--config', path.join(repoRoot, 'vitest.config.ts'), '--root', root],
    { cwd: root, env, maxBuffer: 16 * 1024 * 1024 },
  );
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`vitest list produced no JSON:\n${stdout}`);
  const entries = JSON.parse(stdout.slice(start)) as Array<{ file: string }>;
  const realRoot = await realpath(root);
  return entries.map((e) => path.relative(realRoot, e.file).split(path.sep).join('/')).sort();
}

const underScenarios = (file: string): boolean => file.startsWith(SCENARIO_PREFIX);

describe('npm test scope', () => {
  it('judges the scenario directory from the start of the path, not by substring', () => {
    expect(underScenarios(`${SCENARIO_PREFIX}d-secret-output.bench.ts`)).toBe(true);
    expect(underScenarios(`${SCENARIO_PREFIX}support/harness.test.ts`)).toBe(true);
    expect(underScenarios('tests/unit/bench/harness-measurement.test.ts')).toBe(false);
    expect(underScenarios(`tests/unit/${SCENARIO_PREFIX}x.test.ts`)).toBe(false);
  });

  it(
    'collects no file under the scenario directory in the repository',
    async () => {
      const files = await collectedFiles(repoRoot);
      expect(files).toContain('tests/unit/harness/test-scope.test.ts');
      expect(files).toContain('tests/unit/bench/harness-measurement.test.ts');
      expect(files.filter(underScenarios)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  describe('against a sentinel tree', () => {
    let base: string;
    let root: string;

    beforeAll(async () => {
      base = path.join(await realpath(os.tmpdir()), 'ckpt-test-scope.noindex');
      await mkdir(base, { recursive: true, mode: 0o700 });
      root = await mkdtemp(path.join(base, 'sentinel-'));
      for (const rel of ['tests/unit/bench/x.test.ts', `${SCENARIO_PREFIX}h.test.ts`, `${SCENARIO_PREFIX}support/i.test.ts`, `${SCENARIO_PREFIX}g.bench.ts`]) {
        const file = path.join(root, rel);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "import { test } from 'vitest';\ntest('sentinel', () => {});\n");
      }
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it(
      'collects the unit test but no test or bench file planted under the scenario directory',
      async () => {
        expect(await collectedFiles(root)).toEqual(['tests/unit/bench/x.test.ts']);
      },
      TIMEOUT_MS,
    );
  });
});
