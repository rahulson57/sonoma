/** SPEC-005: one writer per run, enforced by a lockfile; a second writer gets ERR_RUN_LOCKED. */
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import { RunLock, runLockPath, ulid } from '../../../src/storage/index.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, makeTempDir, openBackend } from '../../integration/storage/support.js';

const RUN_A = `run_${ulid(0, () => new Uint8Array(10).fill(1))}`;
const RUN_B = `run_${ulid(0, () => new Uint8Array(10).fill(2))}`;

describe('RunLock', () => {
  let lockDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: lockDir, cleanup } = await makeTempDir('ckpt-lock-'));
  });

  afterEach(async () => {
    await cleanup();
  });

  it('a second writer acquiring the same run lock rejects with ERR_RUN_LOCKED while the first holds it', async () => {
    const first = await RunLock.acquire(lockDir, RUN_A);
    await expect(RunLock.acquire(lockDir, RUN_A)).rejects.toMatchObject({ code: 'ERR_RUN_LOCKED' });
    await expect(RunLock.acquire(lockDir, RUN_A)).rejects.toMatchObject({ code: 'ERR_RUN_LOCKED' });

    await first.release();
    const second = await RunLock.acquire(lockDir, RUN_A);
    expect(second.held).toBe(true);
    await second.release();
  });

  it('locks on different runs are independent', async () => {
    const a = await RunLock.acquire(lockDir, RUN_A);
    const b = await RunLock.acquire(lockDir, RUN_B);
    await a.release();
    await b.release();
  });

  it('reclaims a lock whose holder on this host is no longer alive', async () => {
    const stale = { pid: 424_242, hostname: os.hostname(), token: 'stale-token', acquired_at: '2026-01-01T00:00:00.000Z' };
    await writeFile(runLockPath(lockDir, RUN_A), JSON.stringify(stale), { mode: 0o600 });

    const lock = await RunLock.acquire(lockDir, RUN_A, { isProcessAlive: (pid) => pid !== stale.pid });
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({ pid: process.pid, token: lock.owner.token });
    await lock.release();
  });

  it('does not reclaim a lock whose holder is alive, nor one it cannot read', async () => {
    const live = { pid: process.pid, hostname: os.hostname(), token: 'someone-else', acquired_at: '2026-01-01T00:00:00.000Z' };
    await writeFile(runLockPath(lockDir, RUN_A), JSON.stringify(live), { mode: 0o600 });
    await expect(RunLock.acquire(lockDir, RUN_A)).rejects.toMatchObject({ code: 'ERR_RUN_LOCKED' });

    await writeFile(runLockPath(lockDir, RUN_B), '', { mode: 0o600 });
    await expect(RunLock.acquire(lockDir, RUN_B, { isProcessAlive: () => false })).rejects.toMatchObject({ code: 'ERR_RUN_LOCKED' });
  });

  it('release leaves a lockfile that is no longer its own', async () => {
    const lock = await RunLock.acquire(lockDir, RUN_A);
    const other = { pid: process.pid, hostname: os.hostname(), token: 'replaced', acquired_at: '2026-01-01T00:00:00.000Z' };
    await writeFile(lock.path, JSON.stringify(other));
    await lock.release();
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({ token: 'replaced' });
  });
});

describe('LocalBackend single writer per run', () => {
  it('a second backend writing the same run gets ERR_RUN_LOCKED until the first closes', async () => {
    const repo = await tmpGitRepo();
    const { backend: first } = await openBackend(repo.dir);
    const { backend: second } = await openBackend(repo.dir);
    try {
      const run = await first.createRun({ agent: 'claude-code' });
      await first.appendEvent(run.run_id, { type: 'agent.started', actor: 'runtime', payload: {} });

      await expect(second.appendEvent(run.run_id, { type: 'context.built', actor: 'runtime', payload: {} })).rejects.toMatchObject({
        code: 'ERR_RUN_LOCKED',
      });
      await expect(checkpointFiles(second, { run_id: run.run_id, parent_checkpoint_id: null }, { 'a.txt': 'a' })).rejects.toMatchObject({
        code: 'ERR_RUN_LOCKED',
      });
      await expect(second.reindex()).rejects.toMatchObject({ code: 'ERR_RUN_LOCKED' });

      // Other runs are not blocked.
      const other = await second.createRun({ agent: 'sdk' });
      await second.appendEvent(other.run_id, { type: 'agent.started', actor: 'runtime', payload: {} });

      await first.close();
      const next = await second.appendEvent(run.run_id, { type: 'context.built', actor: 'runtime', payload: {} });
      expect(next.seq).toBe(2);
      const events = await second.getEvents(run.run_id, { fromSeq: 1, toSeq: 10 });
      expect(verifyChain(events)).toEqual({ ok: true });
    } finally {
      await first.close();
      await second.close();
      await repo.cleanup();
    }
  });

  it('concurrent appends through one backend form one contiguous chain', async () => {
    const repo = await tmpGitRepo();
    const { backend } = await openBackend(repo.dir);
    try {
      const run = await backend.createRun({ agent: 'claude-code' });
      const sealed = await Promise.all(
        Array.from({ length: 25 }, (_, i) => backend.appendEvent(run.run_id, { type: 'workspace.changed', actor: 'runtime', payload: { i } })),
      );
      expect(sealed.map((event) => event.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      const events = await backend.getEvents(run.run_id, { fromSeq: 1, toSeq: 25 });
      expect(events).toEqual(sealed);
      expect(verifyChain(events)).toEqual({ ok: true });
    } finally {
      await backend.close();
      await repo.cleanup();
    }
  });
});
