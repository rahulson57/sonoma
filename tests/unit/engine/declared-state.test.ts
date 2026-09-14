/**
 * SPEC-006 "Accepts declaredState" (for SPEC-010; operator ruling MSG-3467). checkpoint(runId, {declaredState}):
 * - validates agent_declared claims against this run's state.declared events BEFORE any write;
 * - sanitizes their values;
 * - creates the checkpoint, then stores the claims as its `source: 'declared'` projection.
 * A failed projection write fails checkpoint(). The two writes are not atomic (documented in engine.ts).
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { CheckpointEngine } from '../../../src/engine/index.js';
import type { LedgerEvent, SemanticClaim } from '../../../src/model/types.js';
import { validateSemanticProjection } from '../../../src/model/validate.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { allEvents, engineFixture, flushImmediates, type EngineFixture } from '../../integration/engine/support.js';

function claim(field: SemanticClaim['field'], value: string, eventIds: string[], provenance: Partial<SemanticClaim['provenance']> = {}): SemanticClaim {
  return {
    field,
    value,
    origin: 'agent_declared',
    provenance: { event_ids: eventIds, artifact_refs: [], workspace_paths: [], checkpoint_ids: [], ...provenance },
  };
}

async function declare(fx: EngineFixture, runId: string, payload: Record<string, unknown> = { goal: 'g' }): Promise<LedgerEvent> {
  const [event] = await fx.engine.record([{ run_id: runId, type: 'state.declared', actor: 'agent', payload }]);
  return event!;
}

describe('checkpoint() with declaredState', () => {
  it('stores the claims as the declared projection of the new checkpoint, over the ledger range since its parent', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const first = await declare(fx, run.run_id, { goal: 'ship', next_action: 'test' });
      const declared = [claim('goal', 'ship', [first.event_id]), claim('next_action', 'test', [first.event_id])];
      const c1 = await fx.engine.checkpoint(run.run_id, { declaredState: declared });

      const projections = await fx.backend.listProjections({ runId: run.run_id, checkpointId: c1.checkpoint_id });
      expect(projections).toHaveLength(1);
      expect(validateSemanticProjection(projections[0]).ok).toBe(true);
      expect(projections[0]).toMatchObject({
        checkpointId: 'c_1',
        source: 'declared',
        distiller: null,
        usage: null,
        input: { stateHash: c1.state_hash, ledgerRange: [0, c1.ledger_seq], workspaceCommit: c1.workspace_commit },
      });
      expect(await fx.backend.listClaims({ runId: run.run_id, checkpointId: 'c_1' })).toEqual(declared);

      fx.clock.tick(1000);
      const second = await declare(fx, run.run_id, { decisions: ['use sqlite'] });
      const c2 = await fx.engine.checkpoint(run.run_id, { label: 'milestone', declaredState: [claim('decision', 'use sqlite', [second.event_id])] });
      const [p2] = await fx.backend.listProjections({ runId: run.run_id, checkpointId: c2.checkpoint_id });
      expect(p2?.input.ledgerRange).toEqual([c1.ledger_seq, c2.ledger_seq]);
      expect(p2?.id).not.toBe(projections[0]?.id);
      expect(c2.label).toBe('milestone');
      expect(await fx.backend.listClaims({ runId: run.run_id, checkpointId: 'c_1' })).toEqual(declared);
    } finally {
      await fx.cleanup();
    }
  });

  it('a checkpoint without declaredState (absent or null) stores no projection', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      await declare(fx, run.run_id);
      const c1 = await fx.engine.checkpoint(run.run_id);
      const c2 = await fx.engine.checkpoint(run.run_id, { declaredState: null });
      expect(await fx.backend.listProjections({ runId: run.run_id, checkpointId: c1.checkpoint_id })).toEqual([]);
      expect(await fx.backend.listProjections({ runId: run.run_id, checkpointId: c2.checkpoint_id })).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });

  it('sanitizes every claim value before storing it, whatever the caller sent', async () => {
    const corpus = secretCorpus();
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const event = await declare(fx, run.run_id, { decisions: ['redacted by record()'] });
      const cp = await fx.engine.checkpoint(run.run_id, {
        declaredState: corpus.map((s, i) => claim('decision', `option ${i} (${s.kind}): ${s.value}`, [event.event_id])),
      });
      const stored = await fx.backend.listClaims({ runId: run.run_id, checkpointId: cp.checkpoint_id });
      expect(stored).toHaveLength(corpus.length);
      for (const [i, c] of stored.entries()) {
        expect(c.origin).toBe('agent_declared');
        expect(c.value).toContain(`option ${i}`);
        expect(c.value).toContain('[REDACTED');
        for (const { value } of corpus) expect(c.value.includes(value)).toBe(false);
      }
    } finally {
      await fx.cleanup();
    }
  });

  it('refuses a bad declaredState with ERR_INVALID_INPUT before writing any event, checkpoint or projection', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const other = await fx.engine.startRun({ agent: 'sdk' });
      const early = await declare(fx, run.run_id);
      await fx.engine.checkpoint(run.run_id, { declaredState: [claim('goal', 'g', [early.event_id])] });
      const [started] = await fx.engine.record([{ run_id: run.run_id, type: 'agent.started', actor: 'runtime', payload: {} }]);
      const foreign = await declare(fx, other.run_id);
      const fresh = await declare(fx, run.run_id);

      const before = { events: await allEvents(fx.backend, run.run_id), checkpoints: await fx.backend.listCheckpoints(run.run_id) };
      const cases: Array<[string, unknown]> = [
        ['not an array', { goal: 'g' }],
        ['an empty array', []],
        ['not a SemanticClaim', [{ field: 'goal', value: 7, origin: 'agent_declared', provenance: { event_ids: [fresh.event_id], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] } }]],
        ['a deterministic field', [{ ...claim('goal', 'g', [fresh.event_id]), field: 'workspace_commit' }]],
        ['origin distilled', [{ ...claim('goal', 'g', [fresh.event_id]), origin: 'distilled' }]],
        ['origin human', [{ ...claim('goal', 'g', [fresh.event_id]), origin: 'human' }]],
        ['no event ids', [claim('goal', 'g', [], { checkpoint_ids: ['c_1'] })]],
        ['a workspace path besides the event', [claim('goal', 'g', [fresh.event_id], { workspace_paths: ['src/a.ts'] })]],
        ['an event that is not state.declared', [claim('goal', 'g', [started!.event_id])]],
        ['an unknown event id', [claim('goal', 'g', ['evt_00000000-0000-4000-8000-000000000000'])]],
        ["another run's state.declared event", [claim('goal', 'g', [foreign.event_id])]],
        ["a state.declared event at or before the parent's cursor", [claim('goal', 'g', [early.event_id])]],
        ['one good claim and one bad', [claim('goal', 'g', [fresh.event_id]), claim('next_action', 'n', [early.event_id])]],
      ];
      for (const [name, declaredState] of cases) {
        await expect(fx.engine.checkpoint(run.run_id, { declaredState } as never), name).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
      }
      expect(await allEvents(fx.backend, run.run_id)).toEqual(before.events);
      expect(await fx.backend.listCheckpoints(run.run_id)).toEqual(before.checkpoints);

      // Positive control: the same run still accepts its fresh declaration.
      const c2 = await fx.engine.checkpoint(run.run_id, { declaredState: [claim('goal', 'g', [fresh.event_id])] });
      expect(await fx.backend.listClaims({ runId: run.run_id, checkpointId: c2.checkpoint_id })).toHaveLength(1);
    } finally {
      await fx.cleanup();
    }
  });

  it('NOT ATOMIC: the projection is written after createCheckpoint, so a failed write rejects checkpoint() with the storage error, emits no distill request, and leaves the checkpoint without claims, as a crash between the two writes would', async () => {
    const request = vi.fn();
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' }, engine: { distill: { request } } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const event = await declare(fx, run.run_id);
      const failure = new Error('disk full');
      const put = vi.spyOn(fx.backend, 'putProjection').mockRejectedValueOnce(failure);

      await expect(fx.engine.checkpoint(run.run_id, { label: 'l1', declaredState: [claim('goal', 'g', [event.event_id])] })).rejects.toBe(failure);
      expect(put).toHaveBeenCalledTimes(1);
      await flushImmediates();
      expect(request).not.toHaveBeenCalled();
      // Not atomic: the checkpoint is durable, its declared claims are not.
      expect((await fx.backend.listCheckpoints(run.run_id)).map((c) => c.checkpoint_id)).toEqual(['c_1']);
      expect(await fx.backend.listClaims({ runId: run.run_id, checkpointId: 'c_1' })).toEqual([]);

      // The run keeps working, and a successful labeled checkpoint does emit its request.
      put.mockRestore();
      const next = await declare(fx, run.run_id);
      const c2 = await fx.engine.checkpoint(run.run_id, { label: 'l2', declaredState: [claim('goal', 'g2', [next.event_id])] });
      expect(await fx.backend.listClaims({ runId: run.run_id, checkpointId: c2.checkpoint_id })).toEqual([claim('goal', 'g2', [next.event_id])]);
      await flushImmediates();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await fx.cleanup();
    }
  });

  it('a fresh engine on the same store accepts a state.declared event recorded before it opened (folded from the ledger)', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const event = await declare(fx, run.run_id);
      const fresh = await CheckpointEngine.open({ backend: fx.backend, repoDir: fx.repo.dir });
      const cp = await fresh.checkpoint(run.run_id, { declaredState: [claim('goal', 'g', [event.event_id])] });
      expect(await fx.backend.listClaims({ runId: run.run_id, checkpointId: cp.checkpoint_id })).toEqual([claim('goal', 'g', [event.event_id])]);
    } finally {
      await fx.cleanup();
    }
  });
});
