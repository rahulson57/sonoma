/**
 * Shared fixtures for the Checkpoint Engine tests (SPEC-006). Repositories live under the OS temp dir
 * (tests/helpers/tmpRepo.ts); time comes from tests/helpers/clock.ts. Execution worktrees default to the
 * fixture repository's own git directory, so cleaning up the repository removes them too.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CheckpointEngine, type CheckpointEngineOptions, type CheckpointRef, type NameStatus } from '../../../src/engine/index.js';
import type { Checkpoint, LedgerEvent } from '../../../src/model/types.js';
import { LocalBackend, type LocalBackendOptions } from '../../../src/storage/index.js';
import { fixedClock, type FixedClock } from '../../helpers/clock.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

const execFileAsync = promisify(execFile);

export const START_MS = Date.UTC(2026, 0, 1);

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Inherited GIT_* stripped; optional locks off, so a test's own `git status` never rewrites an index. */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: isolatedGitEnv(), maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: isolatedGitEnv(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export async function writeFiles(dir: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function removeFile(dir: string, rel: string): Promise<void> {
  await rm(path.join(dir, rel));
}

/** Paths of every blob in `commit`'s tree, in git order. */
export async function treePaths(cwd: string, commit: string): Promise<string[]> {
  return (await git(cwd, ['ls-tree', '-r', '-z', '--name-only', commit])).split('\0').filter((p) => p !== '');
}

export async function treeOf(cwd: string, commit: string): Promise<string> {
  return (await git(cwd, ['rev-parse', `${commit}^{tree}`])).trim();
}

export function refOf(checkpoint: Checkpoint): CheckpointRef {
  return { runId: checkpoint.run_id, checkpointId: checkpoint.checkpoint_id };
}

export function allEvents(backend: LocalBackend, runId: string): Promise<LedgerEvent[]> {
  return backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER });
}

/** Parse the plain text output of `git diff --name-status`. */
export function parseNameStatus(text: string): NameStatus[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [status = '', first = '', second] = line.split('\t');
      return second === undefined ? { status, path: first } : { status, path: second, oldPath: first };
    });
}

/** Resolves after pending setImmediate callbacks (and what they schedule) have run. */
export function flushImmediates(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

/** Every byte of every file under `dir`, concatenated. */
export async function bytesUnder(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) chunks.push(await readFile(abs));
    }
  };
  await walk(dir);
  return Buffer.concat(chunks);
}

export interface EngineFixture {
  readonly repo: TmpGitRepo;
  readonly backend: LocalBackend;
  readonly engine: CheckpointEngine;
  readonly clock: FixedClock;
  cleanup(): Promise<void>;
}

export async function engineFixture(
  options: {
    files?: Record<string, string>;
    engine?: Omit<Partial<CheckpointEngineOptions>, 'backend' | 'repoDir'>;
    backend?: Omit<Partial<LocalBackendOptions>, 'repoDir' | 'clock'>;
  } = {},
): Promise<EngineFixture> {
  const repo = await tmpGitRepo({ files: options.files ?? {} });
  const clock = fixedClock(START_MS);
  let backend: LocalBackend | undefined;
  try {
    backend = await LocalBackend.open({ ...options.backend, repoDir: repo.dir, clock });
    const engine = await CheckpointEngine.open({ ...options.engine, backend, repoDir: repo.dir });
    const opened = backend;
    return {
      repo,
      backend: opened,
      engine,
      clock,
      cleanup: async () => {
        await opened.close();
        await repo.cleanup();
      },
    };
  } catch (err) {
    await backend?.close();
    await repo.cleanup();
    throw err;
  }
}
