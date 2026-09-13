/**
 * Shared fixtures for the Local Storage tests (SPEC-005). Repositories and staging trees live under the
 * OS temp dir; time comes from tests/helpers/clock.ts.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Checkpoint } from '../../../src/model/types.js';
import { LocalBackend, type LocalBackendOptions, type NewCheckpoint } from '../../../src/storage/index.js';
import { fixedClock, type FixedClock } from '../../helpers/clock.js';

const execFileAsync = promisify(execFile);

export const START_MS = Date.UTC(2026, 0, 1);
export const NO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Run git against a fixture repo with inherited GIT_* variables stripped. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export interface OpenedBackend {
  backend: LocalBackend;
  clock: FixedClock;
}

export async function openBackend(
  repoDir: string,
  options: Omit<Partial<LocalBackendOptions>, 'repoDir' | 'clock'> & { clock?: FixedClock } = {},
): Promise<OpenedBackend> {
  const clock = options.clock ?? fixedClock(START_MS);
  const backend = await LocalBackend.open({ ...options, repoDir, clock });
  return { backend, clock };
}

/** Write `files` (POSIX relative path → content) under `dir`, creating parent directories. */
export async function writeFiles(dir: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export interface TreeFile {
  readonly mode: string;
  readonly sha: string;
}

/** Every blob of `commit`'s tree (path → mode, object id), in git's order, with byte-exact (-z) paths. */
export async function treeFiles(repoDir: string, commit: string): Promise<Map<string, TreeFile>> {
  const out = await git(repoDir, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const files = new Map<string, TreeFile>();
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode = '', , sha = ''] = record.slice(0, tab).split(' ');
    files.set(record.slice(tab + 1), { mode, sha });
  }
  return files;
}

/** Materialise `files` in a fresh temp directory for the duration of `fn`. */
export async function withStaging<T>(files: Record<string, string | Uint8Array>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'ckpt-staging-'));
  try {
    await writeFiles(dir, files);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type CheckpointInput = Pick<NewCheckpoint, 'run_id' | 'parent_checkpoint_id'> & Partial<Omit<NewCheckpoint, 'stagingDir'>>;

/** createCheckpoint over a staging tree holding exactly `files`. */
export function checkpointFiles(backend: LocalBackend, input: CheckpointInput, files: Record<string, string | Uint8Array>): Promise<Checkpoint> {
  return withStaging(files, (stagingDir) => backend.createCheckpoint({ pending_intent: [], usage: NO_USAGE, ...input, stagingDir }));
}

export interface TreeEntry {
  readonly rel: string;
  readonly mode: number;
  readonly isDirectory: boolean;
}

/** Every entry under `root` (root itself first), with permission bits. */
export async function walkTree(root: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [{ rel: '.', mode: (await stat(root)).mode & 0o777, isDirectory: true }];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const st = await stat(abs);
      out.push({ rel: path.relative(root, abs), mode: st.mode & 0o777, isDirectory: st.isDirectory() });
      if (st.isDirectory()) await walk(abs);
    }
  };
  await walk(root);
  return out;
}

export async function makeTempDir(prefix: string): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
