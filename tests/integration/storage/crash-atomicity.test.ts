/**
 * SPEC-005 "must never expose a checkpoint whose git ref, blobs, checkpoint.created event and index row
 * are not all durable", and "a crash midway leaves no partially visible checkpoint; reindex() rebuilds
 * the index from CAS + refs + ledger".
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { Checkpoint } from '../../../src/model/types.js';
import type { LocalBackend } from '../../../src/storage/index.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, git, openBackend } from './support.js';

class InjectedCrash extends Error {
  override readonly name = 'InjectedCrash';
}

async function expectConsistent(backend: LocalBackend, repoDir: string, runId: string): Promise<Checkpoint[]> {
  const listed = await backend.listCheckpoints(runId);
  const events = await backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER });
  expect(verifyChain(events)).toEqual({ ok: true });
  for (const checkpoint of listed) {
    expect((await git(repoDir, ['rev-parse', `refs/checkpoints/${runId}/${checkpoint.checkpoint_id}`])).trim()).toBe(checkpoint.workspace_commit);
    const created = events.find((event) => event.seq === checkpoint.ledger_seq);
    expect(created?.type).toBe('checkpoint.created');
    expect(created?.payload).toEqual(checkpoint);
    await expect(backend.getState(checkpoint)).resolves.toMatchObject({ checkpoint_id: checkpoint.checkpoint_id });
  }
  // The converse (DEC-018): no checkpoint.created event is visible without its checkpoint index row.
  expect(events.filter((event) => event.type === 'checkpoint.created').map((event) => event.seq)).toEqual(
    listed.map((checkpoint) => checkpoint.ledger_seq),
  );
  return listed;
}

describe('checkpoint crash atomicity', () => {
  it('a crash after the git ref write but before the index row leaves listCheckpoints without it; reindex() restores a consistent listing', async () => {
    const repo = await tmpGitRepo();
    let crash = false;
    const faults = {
      afterRefWrite: () => {
        if (crash) throw new InjectedCrash('process died after the ref write');
      },
    };
    try {
      const { backend } = await openBackend(repo.dir, { faults });
      const run = await backend.createRun({ agent: 'claude-code' });
      await backend.appendEvent(run.run_id, { type: 'agent.started', actor: 'runtime', payload: {} });
      const c1 = await checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: null }, { 'a.txt': 'one\n' });

      crash = true;
      await expect(checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: 'c_1' }, { 'a.txt': 'two\n' })).rejects.toBeInstanceOf(
        InjectedCrash,
      );
      // The ref did land before the crash…
      expect((await git(repo.dir, ['for-each-ref', '--format=%(refname)', `refs/checkpoints/${run.run_id}/`])).trim().split('\n')).toHaveLength(2);
      // …but the checkpoint is not visible.
      expect((await backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual(['c_1']);
      await backend.close();

      const restarted = await openBackend(repo.dir);
      try {
        expect((await restarted.backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual(['c_1']);
        await expect(restarted.backend.getCheckpoint({ run_id: run.run_id, checkpoint_id: 'c_2' })).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });

        expect(await restarted.backend.reindex()).toEqual({ runs: 1, checkpoints: 1, events: 2, projections: 0, claims: 0 });
        expect(await expectConsistent(restarted.backend, repo.dir, run.run_id)).toEqual([c1]);

        // The run continues: the next checkpoint takes c_2 and replaces the orphan ref.
        const c2 = await checkpointFiles(restarted.backend, { run_id: run.run_id, parent_checkpoint_id: 'c_1' }, { 'a.txt': 'two, again\n' });
        expect(c2).toMatchObject({ checkpoint_id: 'c_2', ledger_seq: 3 });
        expect(await expectConsistent(restarted.backend, repo.dir, run.run_id)).toEqual([c1, c2]);
      } finally {
        await restarted.backend.close();
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('a crash after the checkpoint.created event but before the index row stays hidden until reindex() restores it', async () => {
    const repo = await tmpGitRepo();
    let crash = false;
    const faults = {
      afterCheckpointEvent: () => {
        if (crash) throw new InjectedCrash('process died before the index rows');
      },
    };
    try {
      const { backend } = await openBackend(repo.dir, { faults });
      const run = await backend.createRun({ agent: 'claude-code' });
      const c1 = await checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: null }, { 'a.txt': 'one\n' });
      crash = true;
      await expect(
        checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: 'c_1', label: 'before crash' }, { 'a.txt': 'two\n' }),
      ).rejects.toBeInstanceOf(InjectedCrash);
      expect((await backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual(['c_1']);
      await backend.close();

      const restarted = await openBackend(repo.dir);
      try {
        expect((await restarted.backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual(['c_1']);
        expect(await restarted.backend.getEvents(run.run_id, { fromSeq: 1, toSeq: 100 })).toHaveLength(1);

        expect(await restarted.backend.reindex()).toEqual({ runs: 1, checkpoints: 2, events: 2, projections: 0, claims: 0 });
        const listed = await expectConsistent(restarted.backend, repo.dir, run.run_id);
        expect(listed.map((cp) => cp.checkpoint_id)).toEqual(['c_1', 'c_2']);
        expect(listed[0]).toEqual(c1);
        expect(listed[1]).toMatchObject({ label: 'before crash', parent_checkpoint_id: 'c_1', ledger_seq: 2 });
        expect(await restarted.backend.getState({ run_id: run.run_id, checkpoint_id: 'c_2' })).toMatchObject({ ledger_seq: 2 });
      } finally {
        await restarted.backend.close();
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('a torn final ledger line is never exposed and is truncated before the next append', async () => {
    const repo = await tmpGitRepo();
    try {
      const { backend } = await openBackend(repo.dir);
      const run = await backend.createRun({ agent: 'claude-code' });
      await backend.appendEvent(run.run_id, { type: 'agent.started', actor: 'runtime', payload: {} });
      await backend.close();

      const log = path.join(repo.dir, '.ckpt', 'runs', run.run_id, 'events.jsonl');
      await appendFile(log, '{"event_id":"evt_torn","run_id":');

      const restarted = await openBackend(repo.dir);
      try {
        await restarted.backend.reindex();
        expect(await restarted.backend.getEvents(run.run_id, { fromSeq: 1, toSeq: 10 })).toHaveLength(1);
        const next = await restarted.backend.appendEvent(run.run_id, { type: 'context.built', actor: 'runtime', payload: {} });
        expect(next.seq).toBe(2);
        const lines = (await readFile(log, 'utf8')).split('\n');
        expect(lines.filter((line) => line !== '')).toHaveLength(2);
        expect(verifyChain(await restarted.backend.getEvents(run.run_id, { fromSeq: 1, toSeq: 10 }))).toEqual({ ok: true });
      } finally {
        await restarted.backend.close();
      }
    } finally {
      await repo.cleanup();
    }
  });
});
