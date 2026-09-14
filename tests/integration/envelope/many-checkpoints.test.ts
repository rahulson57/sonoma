/**
 * SPEC-014 envelope invariant / SPEC-002 "Checkpoints per run: ≥ 200 (default retention, prunable)" / DEC-008.
 *
 * 200 is the default retention POLICY, not a storage limit: storage must not error past it. This drives 250
 * checkpoints through the real Checkpoint Engine, Redaction, ledger and LocalBackend in one run, then checks that
 * every one of them still resolves via getCheckpoint, both from the backend that wrote them and from a freshly
 * opened backend (so resolvability comes from the durable index, not from memory).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// 250 git-backed checkpoints spawn many git processes; the 30 s project default is too tight on a loaded gate.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { Checkpoint } from '../../../src/model/types.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { fixedClock } from '../../helpers/clock.js';
import { START_MS, allEvents, engineFixture } from '../engine/support.js';

/** Past SPEC-002's 200-checkpoint default retention, which must not act as a cap. */
const CHECKPOINTS = 250;

describe('many checkpoints in one run (200 is retention policy, not a cap)', () => {
  it(`creates ${CHECKPOINTS} checkpoints in one run and all ${CHECKPOINTS} resolve via getCheckpoint`, async () => {
    const fx = await engineFixture({ files: { 'progress.txt': 'step 0\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'envelope-many-checkpoints' });

      const created: Checkpoint[] = [];
      for (let i = 1; i <= CHECKPOINTS; i += 1) {
        await writeFile(path.join(fx.repo.dir, 'progress.txt'), `step ${i}\n`);
        created.push(await fx.engine.checkpoint(run.run_id));
      }

      // All succeeded, each is distinct, and they form one parent chain in creation order.
      expect(created).toHaveLength(CHECKPOINTS);
      expect(new Set(created.map((cp) => cp.checkpoint_id)).size).toBe(CHECKPOINTS);
      created.forEach((cp, i) => {
        expect(cp.run_id).toBe(run.run_id);
        expect(cp.parent_checkpoint_id).toBe(i === 0 ? null : created[i - 1]?.checkpoint_id);
      });

      // Every one resolves via getCheckpoint on the writing backend.
      for (const cp of created) {
        await expect(fx.backend.getCheckpoint({ run_id: run.run_id, checkpoint_id: cp.checkpoint_id })).resolves.toEqual(cp);
      }
      expect(await fx.backend.listCheckpoints(run.run_id)).toHaveLength(CHECKPOINTS);

      // The ledger holds every checkpoint.created, gap-free and hash-chained.
      const events = await allEvents(fx.backend, run.run_id);
      expect(events.map((event) => event.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
      expect(verifyChain(events)).toEqual({ ok: true });
      expect(events.filter((event) => event.type === 'checkpoint.created')).toHaveLength(CHECKPOINTS);

      // And from a freshly opened backend: nothing past 200 was pruned or held only in memory.
      await fx.backend.close();
      const reopened = await LocalBackend.open({ repoDir: fx.repo.dir, clock: fixedClock(START_MS) });
      try {
        for (const cp of created) {
          await expect(reopened.getCheckpoint({ run_id: run.run_id, checkpoint_id: cp.checkpoint_id })).resolves.toEqual(cp);
        }
        expect(await reopened.listCheckpoints(run.run_id)).toHaveLength(CHECKPOINTS);
      } finally {
        await reopened.close();
      }
    } finally {
      await fx.cleanup();
    }
  });
});
