/**
 * SPEC-001: `npm test` must never include e2e or bench files.
 *
 * Checked two ways. First against the real repository's `vitest list`, both the JSON file list
 * and the plain text output. Then against a sentinel tree in the OS temp dir that plants a test
 * file in every location, which proves the exclusion before any e2e or bench file exists in the
 * repository.
 * A listed file counts as excluded only when its repository-relative path STARTS with an excluded
 * prefix. SPEC-002's unit tests live under tests/unit/bench/, and `npm test` must collect them, so
 * a substring match on the bench prefix would be wrong.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const vitestCli = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const TIMEOUT_MS = 60_000;
const E2E_PREFIX = ['tests', 'e2e', ''].join('/');
const BENCH_PREFIX = ['bench', ''].join('/');

/** Run `vitest list <args>` with the repository config against `root`; returns stdout. */
async function vitestListRaw(root: string, args: string[]): Promise<string> {
  // Drop the parent run's worker variables so the child behaves like a top-level `npx vitest list`.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
  const { stdout } = await execFileAsync(
    process.execPath,
    [vitestCli, 'list', ...args, '--config', path.join(repoRoot, 'vitest.config.ts'), '--root', root],
    { cwd: root, env, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

/** Listed test files relative to `root`, POSIX-style, sorted. */
async function vitestListFiles(root: string, extraArgs: string[] = []): Promise<string[]> {
  const stdout = await vitestListRaw(root, ['--filesOnly', '--json', ...extraArgs]);
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`vitest list produced no JSON:\n${stdout}`);
  const entries = JSON.parse(stdout.slice(start)) as Array<{ file: string }>;
  const realRoot = await realpath(root);
  return entries.map((e) => path.relative(realRoot, e.file).split(path.sep).join('/')).sort();
}

/**
 * The distinct test files named by plain `vitest list` output, sorted. Each line reads
 * `<relative file> > <suite> > <test>`, so the file is the text before the first ` > `.
 * Suite and test titles are never inspected.
 */
function plainListedFiles(stdout: string): string[] {
  const files = stdout
    .split(/\r?\n/)
    .map((line) => (line.split(' > ')[0] ?? '').trim())
    .filter((file) => file.length > 0);
  return [...new Set(files)].sort();
}

/** True when a repository-relative path lies under tests/e2e/ or the root-level bench/. */
const isExcludedPath = (file: string): boolean => file.startsWith(E2E_PREFIX) || file.startsWith(BENCH_PREFIX);

describe('vitest config', () => {
  it('judges excluded paths from the start of the listed path, not by substring', () => {
    expect(isExcludedPath(`${E2E_PREFIX}c.test.ts`)).toBe(true);
    expect(isExcludedPath(`${E2E_PREFIX}ui/d.spec.ts`)).toBe(true);
    expect(isExcludedPath(`${BENCH_PREFIX}e.bench.ts`)).toBe(true);
    expect(isExcludedPath(`${BENCH_PREFIX}scenarios/g.bench.ts`)).toBe(true);
    expect(isExcludedPath(`tests/unit/${BENCH_PREFIX}results-format.test.ts`)).toBe(false);
    expect(isExcludedPath(`tests/unit/${E2E_PREFIX}x.test.ts`)).toBe(false);
    expect(isExcludedPath('tests/unit/harness/vitest-config.test.ts')).toBe(false);
  });

  it(
    'the repository file listing contains no e2e or benchmark path',
    async () => {
      const files = await vitestListFiles(repoRoot);
      // DEC-013(4): passWithNoTests must never hide an empty `npm test`, so the run collects real tests,
      // including SPEC-002's unit tests under the unit bench directory.
      expect(files).toContain('tests/unit/harness/vitest-config.test.ts');
      expect(files).toContain('tests/unit/bench/results-format.test.ts');
      expect(files).toContain('tests/unit/bench/check-budgets.test.ts');
      expect(files.filter(isExcludedPath)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'the plain `vitest list` output names no e2e or benchmark file',
    async () => {
      const files = plainListedFiles(await vitestListRaw(repoRoot, []));
      expect(files).toContain('tests/unit/harness/vitest-config.test.ts');
      expect(files).toContain('tests/unit/bench/results-format.test.ts');
      expect(files).toContain('tests/unit/bench/check-budgets.test.ts');
      expect(files.filter(isExcludedPath)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  describe('against a sentinel tree', () => {
    let sentinelRoot: string;
    const sentinelFiles = [
      'tests/unit/some-module/a.test.ts',
      'tests/unit/bench/x.test.ts',
      'tests/integration/b.test.ts',
      'tests/e2e/c.test.ts',
      'tests/e2e/ui/d.spec.ts',
      'bench/e.bench.ts',
      'bench/f.test.ts',
      'bench/scenarios/g.bench.ts',
      'bench/scenarios/h.test.ts',
    ];
    const collected = ['tests/integration/b.test.ts', 'tests/unit/bench/x.test.ts', 'tests/unit/some-module/a.test.ts'];

    beforeAll(async () => {
      sentinelRoot = await mkdtemp(path.join(os.tmpdir(), 'ckpt-vitest-config-'));
      for (const rel of sentinelFiles) {
        const file = path.join(sentinelRoot, rel);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "import { test } from 'vitest';\ntest('sentinel', () => {});\n");
      }
    });

    afterAll(async () => {
      await rm(sentinelRoot, { recursive: true, force: true });
    });

    it(
      'npm test collects unit (including unit bench) and integration tests but no e2e or benchmark files',
      async () => {
        expect(await vitestListFiles(sentinelRoot)).toEqual(collected);
      },
      TIMEOUT_MS,
    );

    it(
      'the plain listing check keeps the unit bench test and flags nothing else',
      async () => {
        const files = plainListedFiles(await vitestListRaw(sentinelRoot, []));
        expect(files).toEqual(collected);
        expect(files.filter(isExcludedPath)).toEqual([]);
      },
      TIMEOUT_MS,
    );

    it(
      'the plain listing check catches a real e2e file when one is listed',
      async () => {
        const files = plainListedFiles(await vitestListRaw(sentinelRoot, ['--dir', 'tests/e2e']));
        expect(files.filter(isExcludedPath)).toEqual(['tests/e2e/c.test.ts']);
      },
      TIMEOUT_MS,
    );

    it(
      'npm run test:e2e (--dir) still reaches the e2e suite',
      async () => {
        expect(await vitestListFiles(sentinelRoot, ['--dir', 'tests/e2e'])).toEqual(['tests/e2e/c.test.ts']);
      },
      TIMEOUT_MS,
    );
  });

  describe('with no test or scenario files at all', () => {
    /** Run the vitest CLI with the repository config in a fresh empty temp root; never rejects. */
    async function vitestInEmptyRoot(args: string[]): Promise<{ code: number; root: string; output: string }> {
      const root = await mkdtemp(path.join(os.tmpdir(), 'ckpt-vitest-empty-'));
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [vitestCli, ...args, '--config', path.join(repoRoot, 'vitest.config.ts'), '--root', root],
          { cwd: root, env, maxBuffer: 16 * 1024 * 1024 },
        );
        return { code: 0, root, output: stdout + stderr };
      } catch (err) {
        const e = err as { code?: unknown; stdout?: string; stderr?: string };
        return { code: typeof e.code === 'number' ? e.code : -1, root, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    }

    it(
      'npm run bench exits 0 and writes an empty report before any scenario exists',
      async () => {
        const { code, root, output } = await vitestInEmptyRoot(['bench', '--run', '--outputJson', 'bench/results.json']);
        try {
          expect(code, output).toBe(0);
          expect(JSON.parse(await readFile(path.join(root, 'bench', 'results.json'), 'utf8'))).toEqual({ files: [] });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      TIMEOUT_MS,
    );

    it(
      'npm test still fails when it finds no test files (passWithNoTests is benchmark-only)',
      async () => {
        const { code, root, output } = await vitestInEmptyRoot(['run']);
        try {
          expect(code, output).not.toBe(0);
          expect(output).toMatch(/No test files found/);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      TIMEOUT_MS,
    );
  });
});
