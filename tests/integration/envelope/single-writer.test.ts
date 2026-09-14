/**
 * SPEC-014 envelope invariant / SPEC-002 "Concurrent checkpoint writers: exactly 1 per run" / DEC-008.
 *
 * Exercised through the real Checkpoint Engine over LocalBackend (no stubs):
 * 1. A second writer (its own backend and engine on the same store) is rejected with ERR_RUN_LOCKED for both
 *    checkpoint() and record(), and leaves nothing behind: no ledger event, no checkpoint row, no checkpoint ref.
 *    The ledger stays gap-free and hash-chained, and once the first writer closes, the second continues it
 *    without a gap.
 * 2. Concurrent checkpoint() and record() calls on one run through one engine are serialised into a single
 *    gap-free chain.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Git-backed checkpoints spawn many git processes; keep generous limits on a loaded gate.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
import { CheckpointEngine } from '../../../src/engine/index.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { Checkpoint, LedgerEvent } from '../../../src/model/types.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { fixedClock } from '../../helpers/clock.js';
import { START_MS, allEvents, engineFixture, git } from '../engine/support.js';

function expectGapFree(events: LedgerEvent[]): void {
  expect(events.map((event) => event.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
  expect(verifyChain(events)).toEqual({ ok: true });
}

async function checkpointRefs(repoDir: string, runId: string): Promise<string[]> {
  const out = await git(repoDir, ['for-each-ref', '--format=%(refname)', `refs/checkpoints/${runId}/`]);
  return out
    .split('\n')
    .filter((line) => line !== '')
    .sort();
}

describe('single checkpoint writer per run', () => {
  it('a second concurrent writer on the same run is rejected and the ledger has no gaps', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    const secondBackend = await LocalBackend.open({ repoDir: fx.repo.dir, clock: fixedClock(START_MS) });
    try {
      const second = await CheckpointEngine.open({ backend: secondBackend, repoDir: fx.repo.dir });

      const run = await fx.engine.startRun({ agent: 'envelope-writer-one' });
      const c1 = await fx.engine.checkpoint(run.run_id);
      await writeFile(path.join(fx.repo.dir, 'a.txt'), 'b\n');

      // The second writer is rejected while the first holds the run.
      await expect(second.checkpoint(run.run_id)).rejects.toMatchObject({ code: 'ERR_RUN_LOCKED' });
      await expect(
        second.record([{ run_id: run.run_id, type: 'workspace.changed', actor: 'runtime', payload: { path: 'a.txt' } }]),
      ).rejects.toMatchObject({ code: 'ERR_RUN_LOCKED' });

      // It left nothing: the ledger, the checkpoint index and the refs hold only the first writer's work.
      const afterRejection = await allEvents(fx.backend, run.run_id);
      expectGapFree(afterRejection);
      expect(afterRejection.map((event) => event.type)).toEqual(['run.created', 'checkpoint.created']);
      expect((await fx.backend.listCheckpoints(run.run_id)).map((cp) => cp.checkpoint_id)).toEqual([c1.checkpoint_id]);
      expect(await checkpointRefs(fx.repo.dir, run.run_id)).toEqual([`refs/checkpoints/${run.run_id}/${c1.checkpoint_id}`]);

      // The first writer carries on as if nothing happened.
      const c2 = await fx.engine.checkpoint(run.run_id);
      expect(c2.parent_checkpoint_id).toBe(c1.checkpoint_id);
      expect(c2.ledger_seq).toBe(c1.ledger_seq + 1);

      // Once the first writer is gone, the second continues the same ledger without a gap.
      await fx.backend.close();
      await writeFile(path.join(fx.repo.dir, 'a.txt'), 'c\n');
      const c3 = await second.checkpoint(run.run_id);
      expect(c3.parent_checkpoint_id).toBe(c2.checkpoint_id);
      expect(c3.ledger_seq).toBe(c2.ledger_seq + 1);

      const events = await allEvents(secondBackend, run.run_id);
      expectGapFree(events);
      expect(events.map((event) => event.type)).toEqual(['run.created', 'checkpoint.created', 'checkpoint.created', 'checkpoint.created']);
      expect(await checkpointRefs(fx.repo.dir, run.run_id)).toEqual(
        [c1, c2, c3].map((cp) => `refs/checkpoints/${run.run_id}/${cp.checkpoint_id}`).sort(),
      );
    } finally {
      await secondBackend.close();
      await fx.cleanup();
    }
  });

  it('concurrent checkpoint() and record() calls on one run are serialised into one gap-free ledger', async () => {
    const fx = await engineFixture({ files: { 'a.txt': '0\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'envelope-concurrent-calls' });
      const ROUNDS = 10;

      const pending: Array<Promise<LedgerEvent[] | Checkpoint>> = [];
      for (let i = 0; i < ROUNDS; i += 1) {
        pending.push(fx.engine.record([{ run_id: run.run_id, type: 'workspace.changed', actor: 'runtime', payload: { round: i } }]));
        pending.push(fx.engine.checkpoint(run.run_id));
      }
      const settled = await Promise.all(pending);

      const checkpoints = settled.filter((value): value is Checkpoint => !Array.isArray(value));
      expect(checkpoints).toHaveLength(ROUNDS);
      expect(new Set(checkpoints.map((cp) => cp.checkpoint_id)).size).toBe(ROUNDS);

      const events = await allEvents(fx.backend, run.run_id);
      expectGapFree(events);
      expect(events).toHaveLength(1 + ROUNDS * 2);
      const indexedSeqs = (await fx.backend.listCheckpoints(run.run_id)).map((cp) => cp.ledger_seq).sort((a, b) => a - b);
      expect(indexedSeqs).toEqual(checkpoints.map((cp) => cp.ledger_seq).sort((a, b) => a - b));
    } finally {
      await fx.cleanup();
    }
  });
});
