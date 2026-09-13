/** SPEC-005: checkpoint.db is a rebuildable index — reindex() reproduces it from CAS + refs + ledger. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { Checkpoint, LedgerEvent } from '../../../src/model/types.js';
import type { LocalBackend } from '../../../src/storage/index.js';
import { fakeLedgerEvents } from '../../helpers/ledger.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, git, openBackend } from './support.js';

interface Snapshot {
  checkpoints: Checkpoint[];
  events: LedgerEvent[];
}

async function snapshot(backend: LocalBackend, runIds: readonly string[]): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  for (const runId of runIds) {
    out[runId] = {
      checkpoints: await backend.listCheckpoints(runId),
      events: await backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER }),
    };
  }
  return out;
}

/** Replay fake agent activity (minus checkpoint.created, which only createCheckpoint may emit). */
async function replay(backend: LocalBackend, runId: string, count: number, seed: number): Promise<void> {
  for (const event of fakeLedgerEvents(count, seed).filter((candidate) => candidate.type !== 'checkpoint.created')) {
    await backend.appendEvent(runId, { type: event.type, actor: event.actor, payload: event.payload });
  }
}

describe('reindex', () => {
  it('deleting checkpoint.db and calling reindex() reproduces identical listCheckpoints and getEvents results for 3 runs', async () => {
    const repo = await tmpGitRepo({ files: { 'src/index.ts': 'export {};\n' } });
    try {
      const { backend, clock } = await openBackend(repo.dir);
      const first = await backend.createRun({ agent: 'claude-code' });
      const second = await backend.createRun({ agent: 'sdk' });

      await replay(backend, first.run_id, 40, 11);
      const f1 = await checkpointFiles(backend, { run_id: first.run_id, parent_checkpoint_id: null }, { 'src/index.ts': 'export const a = 1;\n' });
      clock.tick(5000);
      await replay(backend, first.run_id, 25, 12);
      await backend.appendEvent(first.run_id, { type: 'tool.completed', actor: 'runtime', payload: { stdout: 'o'.repeat(MAX_INLINE_PAYLOAD_BYTES + 10) } });
      await checkpointFiles(backend, { run_id: first.run_id, parent_checkpoint_id: f1.checkpoint_id, label: 'handoff' }, { 'src/index.ts': 'export const a = 2;\n' });

      await replay(backend, second.run_id, 30, 21);
      await checkpointFiles(backend, { run_id: second.run_id, parent_checkpoint_id: null }, { 'README.md': 'second\n' });

      const third = await backend.fork({ run_id: first.run_id, checkpoint_id: f1.checkpoint_id });
      expect(third).toMatchObject({ parent_run_id: first.run_id, forked_from_checkpoint: 'c_1', agent: 'claude-code' });
      await replay(backend, third.run_id, 10, 31);
      const t1 = await checkpointFiles(backend, { run_id: third.run_id, parent_checkpoint_id: null }, { 'src/index.ts': 'export const a = 100;\n' });
      // A fork's first commit descends from the checkpoint it was forked from.
      expect((await git(repo.dir, ['rev-parse', `${t1.workspace_commit}^`])).trim()).toBe(f1.workspace_commit);

      const runIds = [first.run_id, second.run_id, third.run_id];
      const before = await snapshot(backend, runIds);
      const totals = Object.values(before).reduce(
        (sum, run) => ({ checkpoints: sum.checkpoints + run.checkpoints.length, events: sum.events + run.events.length }),
        { checkpoints: 0, events: 0 },
      );
      expect(totals.checkpoints).toBe(4);
      await backend.close();

      const store = path.join(repo.dir, '.ckpt');
      for (const file of ['checkpoint.db', 'checkpoint.db-wal', 'checkpoint.db-shm']) {
        await rm(path.join(store, file), { force: true });
      }

      const { backend: rebuilt } = await openBackend(repo.dir);
      try {
        expect(await rebuilt.listCheckpoints(first.run_id)).toEqual([]);
        expect(await rebuilt.reindex()).toEqual({ runs: 3, ...totals });

        const after = await snapshot(rebuilt, runIds);
        expect(after).toEqual(before);
        for (const runId of runIds) {
          expect(verifyChain(after[runId]!.events)).toEqual({ ok: true });
          for (const checkpoint of after[runId]!.checkpoints) {
            await expect(rebuilt.getState(checkpoint)).resolves.toMatchObject({ run_id: runId, checkpoint_id: checkpoint.checkpoint_id });
          }
        }

        // Reindexing a live index is idempotent, and writing continues from the durable head.
        expect(await rebuilt.reindex()).toEqual({ runs: 3, ...totals });
        const next = await rebuilt.appendEvent(second.run_id, { type: 'agent.interrupted', actor: 'runtime', payload: {} });
        expect(next.seq).toBe(before[second.run_id]!.events.length + 1);
      } finally {
        await rebuilt.close();
      }
    } finally {
      await repo.cleanup();
    }
    // Three runs of fake activity plus git checkpoints; the default 5 s is too tight under parallel suites.
  }, 60_000);
});
