/**
 * Single writer per run (SPEC-005 "Concurrency and durability"): a lockfile `.ckpt/lock/<run_id>.lock`.
 *
 * - Acquire = exclusive create (O_EXCL) of a 0600 file holding {pid, hostname, token}. While another
 *   holder's file exists, acquisition rejects with ERR_RUN_LOCKED.
 * - A lock left by a crashed process is reclaimed when its holder is on this host and its pid is no
 *   longer alive. Reclaim renames the stale file aside and re-checks its token, so two processes racing
 *   to reclaim the same stale lock cannot delete a lock one of them has just taken.
 * - A lockfile whose content cannot be read as an owner (e.g. a crash mid-create) is treated as held:
 *   it cannot be proven dead. Remove it by hand only when no ckpt process is running.
 * - Release removes the file only if it still carries this holder's token.
 */
import { randomBytes } from 'node:crypto';
import { link, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageError } from './errors.js';
import { errnoCode, writeExclusive } from './fs-util.js';
import { assertRunId } from './layout.js';

export interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly acquired_at: string;
}

export interface RunLockOptions {
  /** Liveness probe for a holder's pid. Defaults to `process.kill(pid, 0)`. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Epoch ms, recorded in the lockfile for humans. */
  readonly now?: () => number;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === 'EPERM';
  }
}

export function runLockPath(lockDir: string, runId: string): string {
  assertRunId(runId);
  return path.join(lockDir, `${runId}.lock`);
}

function parseOwner(text: string): LockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof value.pid === 'number' &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.hostname === 'string' &&
      typeof value.token === 'string' &&
      value.token.length > 0
    ) {
      return value as LockOwner;
    }
  } catch {
    // fall through
  }
  return null;
}

/** undefined: no lockfile. null: a lockfile whose owner cannot be read. */
async function readOwner(file: string): Promise<LockOwner | null | undefined> {
  try {
    return parseOwner(await readFile(file, 'utf8'));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

function lockedError(runId: string, holder: LockOwner | null): StorageError {
  const who = holder ? `pid ${holder.pid} on ${holder.hostname}` : 'an unreadable lockfile';
  return new StorageError('ERR_RUN_LOCKED', `run ${runId} already has a writer (${who})`);
}

/** Move a stale lockfile aside; if it turns out not to be the stale one we saw, put it back. */
async function reclaimStale(file: string, stale: LockOwner): Promise<void> {
  const aside = `${file}.stale-${randomBytes(6).toString('hex')}`;
  try {
    await rename(file, aside);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return;
    throw err;
  }
  const moved = await readOwner(aside);
  if (moved?.token !== stale.token) {
    // Someone acquired between our read and our rename: restore their lock unless yet another holder exists.
    await link(aside, file).catch((err: unknown) => {
      if (errnoCode(err) !== 'EEXIST') throw err;
    });
  }
  await unlink(aside).catch(() => undefined);
}

export class RunLock {
  readonly runId: string;
  readonly path: string;
  readonly owner: LockOwner;
  #released = false;

  private constructor(runId: string, file: string, owner: LockOwner) {
    this.runId = runId;
    this.path = file;
    this.owner = owner;
  }

  /** Take the run's writer lock or reject with ERR_RUN_LOCKED. */
  static async acquire(lockDir: string, runId: string, options: RunLockOptions = {}): Promise<RunLock> {
    const file = runLockPath(lockDir, runId);
    const alive = options.isProcessAlive ?? isProcessAlive;
    const owner: LockOwner = {
      pid: process.pid,
      hostname: os.hostname(),
      token: randomBytes(16).toString('hex'),
      acquired_at: new Date((options.now ?? Date.now)()).toISOString(),
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await writeExclusive(file, JSON.stringify(owner));
        return new RunLock(runId, file, owner);
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST') throw err;
      }
      const holder = await readOwner(file);
      if (holder === undefined) continue; // released between our create and our read
      if (holder === null || holder.hostname !== owner.hostname || alive(holder.pid)) {
        throw lockedError(runId, holder);
      }
      await reclaimStale(file, holder);
    }
    throw new StorageError('ERR_RUN_LOCKED', `run ${runId}: lock is contended`);
  }

  get held(): boolean {
    return !this.#released;
  }

  /** Remove the lockfile if it is still ours. Idempotent. */
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const current = await readOwner(this.path);
    if (current?.token === this.owner.token) {
      await unlink(this.path).catch((err: unknown) => {
        if (errnoCode(err) !== 'ENOENT') throw err;
      });
    }
  }
}
