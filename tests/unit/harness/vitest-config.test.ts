/**
 * SPEC-001: `npm test` must never include e2e or bench files.
 *
 * Checked two ways. First against the real repository's `vitest list`, both the JSON file list
 * and the plain text output the acceptance check greps. Then against a sentinel tree in the OS
 * temp dir that plants a test file in every location, which proves the exclusion before any e2e
 * or bench file exists in the repository.
 * Test titles here deliberately avoid the literal excluded path prefixes, so the plain listing
 * stays greppable.
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

const isExcludedPath = (file: string): boolean => file.startsWith(E2E_PREFIX) || file.startsWith(BENCH_PREFIX);

describe('vitest config', () => {
  it(
    'the repository file listing contains no e2e or benchmark path',
    async () => {
      const files = await vitestListFiles(repoRoot);
      expect(files).toContain('tests/unit/harness/vitest-config.test.ts');
      expect(files.filter(isExcludedPath)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'the plain `vitest list` output never mentions an e2e or benchmark path',
    async () => {
      const stdout = await vitestListRaw(repoRoot, []);
      expect(stdout).toContain('vitest-config.test.ts');
      expect(stdout.includes(E2E_PREFIX), 'plain listing mentions the e2e prefix').toBe(false);
      expect(stdout.includes(BENCH_PREFIX), 'plain listing mentions the bench prefix').toBe(false);
    },
    TIMEOUT_MS,
  );

  describe('against a sentinel tree', () => {
    let sentinelRoot: string;
    const sentinelFiles = [
      'tests/unit/some-module/a.test.ts',
      'tests/integration/b.test.ts',
      'tests/e2e/c.test.ts',
      'tests/e2e/ui/d.spec.ts',
      'bench/e.bench.ts',
      'bench/f.test.ts',
    ];

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
      'npm test collects unit and integration tests but no e2e or benchmark files',
      async () => {
        expect(await vitestListFiles(sentinelRoot)).toEqual(['tests/integration/b.test.ts', 'tests/unit/some-module/a.test.ts']);
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
});
