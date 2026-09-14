/** SPEC-010 "each save() produces a new checkpoint" and never mutates or overwrites an earlier checkpoint's claims. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { createCkpt, type CheckpointRef } from '../../../src/sdk/index.js';
import { engineFixture, sha256, type EngineFixture } from '../engine/support.js';

/** The first checkpoint's claims and projections as canonical JSON, plus the projection blob bytes stored in CAS. */
async function snapshotOf(fx: EngineFixture, ref: CheckpointRef): Promise<{ claims: string; projections: string; blobs: Buffer[] }> {
  const query = { runId: ref.runId, checkpointId: ref.checkpointId };
  const projections = await fx.backend.listProjections(query);
  const blobs = await Promise.all(
    projections.map((p) => {
      const hash = sha256(canonicalJSON(p));
      return readFile(path.join(fx.repo.dir, '.ckpt', 'objects', 'sha256', hash.slice(0, 2), hash));
    }),
  );
  return { claims: canonicalJSON(await fx.backend.listClaims(query)), projections: canonicalJSON(projections), blobs };
}

describe('save() immutability', () => {
  it("two consecutive save() calls create two distinct checkpoints and the first checkpoint's claims are byte-identical afterwards", async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const ckpt = createCkpt({ engine: fx.engine, runId: run.run_id });

      const first = await ckpt.save({ goal: 'first goal', decisions: ['first decision'] });
      const before = await snapshotOf(fx, first);
      expect(JSON.parse(before.claims)).toHaveLength(2);
      expect(before.blobs).toHaveLength(1);

      fx.clock.tick(5000);
      const second = await ckpt.save({ goal: 'second goal', assumptions: ['second assumption'] });

      expect(second.runId).toBe(first.runId);
      expect(second.checkpointId).not.toBe(first.checkpointId);
      const secondCheckpoint = await fx.backend.getCheckpoint({ run_id: second.runId, checkpoint_id: second.checkpointId });
      expect(secondCheckpoint.parent_checkpoint_id).toBe(first.checkpointId);

      const after = await snapshotOf(fx, first);
      expect(after.claims).toBe(before.claims);
      expect(after.projections).toBe(before.projections);
      expect(Buffer.concat(after.blobs).equals(Buffer.concat(before.blobs))).toBe(true);

      // The second checkpoint holds only its own declaration, citing a different state.declared event.
      const firstClaims = await fx.backend.listClaims({ runId: first.runId, checkpointId: first.checkpointId });
      const secondClaims = await fx.backend.listClaims({ runId: second.runId, checkpointId: second.checkpointId });
      expect(secondClaims.map((c) => c.value)).toEqual(['second goal', 'second assumption']);
      expect(secondClaims[0]?.provenance.event_ids).not.toEqual(firstClaims[0]?.provenance.event_ids);

      // Rebuilding the index from CAS, refs and runs/ reproduces the first checkpoint's claims byte for byte.
      await fx.backend.reindex();
      const reindexed = await snapshotOf(fx, first);
      expect(reindexed.claims).toBe(before.claims);
      expect(reindexed.projections).toBe(before.projections);
    } finally {
      await fx.cleanup();
    }
  });
});
