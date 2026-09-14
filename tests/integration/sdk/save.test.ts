/** SPEC-010 save() against the real Checkpoint Engine and LocalBackend. */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { createCkpt } from '../../../src/sdk/index.js';
import { allEvents, engineFixture } from '../engine/support.js';

describe('save()', () => {
  it("save({goal, next_action}) yields a checkpoint whose claims all have origin 'agent_declared' and non-empty provenance.event_ids referencing a state.declared event", async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const ckpt = createCkpt({ engine: fx.engine, runId: run.run_id });
      const declared = { goal: 'Migrate the billing service to the new queue', next_action: 'Run the integration suite' };

      const ref = await ckpt.save(declared);

      expect(ref).toEqual({ runId: run.run_id, checkpointId: 'c_1' });
      const checkpoint = await fx.backend.getCheckpoint({ run_id: ref.runId, checkpoint_id: ref.checkpointId });
      const claims = await fx.backend.listClaims({ runId: ref.runId, checkpointId: ref.checkpointId });
      expect(claims.map((c) => [c.field, c.value])).toEqual([
        ['goal', declared.goal],
        ['next_action', declared.next_action],
      ]);

      const events = await allEvents(fx.backend, run.run_id);
      const byId = new Map(events.map((event) => [event.event_id, event]));
      for (const c of claims) {
        expect(c.origin).toBe('agent_declared');
        expect(c.provenance.event_ids.length).toBeGreaterThan(0);
        for (const id of c.provenance.event_ids) {
          const event = byId.get(id);
          expect(event?.type).toBe('state.declared');
          expect(event?.run_id).toBe(run.run_id);
          expect(event!.seq).toBeLessThanOrEqual(checkpoint.ledger_seq);
          expect(event?.payload).toEqual(declared);
        }
      }
      expect(events.filter((event) => event.type === 'state.declared')).toHaveLength(1);

      const [projection, ...others] = await fx.backend.listProjections({ runId: ref.runId, checkpointId: ref.checkpointId });
      expect(others).toEqual([]);
      expect(projection).toMatchObject({ source: 'declared', distiller: null, usage: null, input: { stateHash: checkpoint.state_hash } });
    } finally {
      await fx.cleanup();
    }
  });

  it('declares lists as one claim per entry, passes the label, and makes no distill call itself', async () => {
    const request = vi.fn();
    const fx = await engineFixture({ files: { 'README.md': '# app\n' }, engine: { distill: { request } } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const ckpt = createCkpt({ engine: fx.engine, runId: run.run_id });
      const ref = await ckpt.save({ current_step: 'schema', decisions: ['use WAL', 'no ORM'], assumptions: ['single writer'] }, { label: 'schema done' });

      expect((await fx.backend.getCheckpoint({ run_id: ref.runId, checkpoint_id: ref.checkpointId })).label).toBe('schema done');
      const claims = await fx.backend.listClaims({ runId: ref.runId, checkpointId: ref.checkpointId });
      expect(claims.map((c) => [c.field, c.value, c.origin])).toEqual([
        ['current_step', 'schema', 'agent_declared'],
        ['decision', 'use WAL', 'agent_declared'],
        ['decision', 'no ORM', 'agent_declared'],
        ['assumption', 'single writer', 'agent_declared'],
      ]);
    } finally {
      await fx.cleanup();
    }
  });

  it('NOT ATOMIC: claims are written after createCheckpoint, so a failed claims write rejects save() with no CheckpointRef and leaves that checkpoint without claims, as a crash between the two writes would', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const ckpt = createCkpt({ engine: fx.engine, runId: run.run_id });
      const failure = new Error('disk full');
      vi.spyOn(fx.backend, 'putProjection').mockRejectedValueOnce(failure);

      await expect(ckpt.save({ goal: 'g' })).rejects.toBe(failure);
      // The checkpoint was already durable when the claims write failed: it stays, with no declared claims.
      expect(await fx.backend.listClaims({ runId: run.run_id, checkpointId: 'c_1' })).toEqual([]);
      // The next save still works and lands on a new checkpoint with its claims.
      const ref = await ckpt.save({ goal: 'g2' });
      expect(ref.checkpointId).toBe('c_2');
      expect((await fx.backend.listClaims({ runId: ref.runId, checkpointId: ref.checkpointId })).map((c) => c.value)).toEqual(['g2']);
    } finally {
      await fx.cleanup();
    }
  });
});
