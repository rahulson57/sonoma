/** SPEC-010 save() orchestration against a fake Engine: record state.declared, then checkpoint with the claims. */
import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, LedgerEvent, LedgerEventDraft } from '../../../src/model/types.js';
import { createCkpt, type DeclaredStateEngine } from '../../../src/sdk/index.js';

const RUN = 'run_01J00000000000000000000000';

function sealed(draft: LedgerEventDraft, seq: number): LedgerEvent {
  return {
    event_id: `evt_${seq}`,
    run_id: draft.run_id,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    type: draft.type,
    actor: draft.actor,
    intent_id: null,
    payload: draft.payload,
    payload_ref: null,
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  };
}

function fakeEngine() {
  let seq = 0;
  let n = 0;
  const record = vi.fn(async (drafts: readonly LedgerEventDraft[]): Promise<LedgerEvent[]> => drafts.map((d) => sealed(d, ++seq)));
  const checkpoint = vi.fn(async (runId: string, _options?: unknown): Promise<Checkpoint> => ({ run_id: runId, checkpoint_id: `c_${++n}` }) as Checkpoint);
  const engine: DeclaredStateEngine = { record, checkpoint };
  return { engine, record, checkpoint };
}

const provenance = (eventId: string) => ({ event_ids: [eventId], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] });

describe('createCkpt().save()', () => {
  it('records one state.declared event, then checkpoints with agent_declared claims citing it, and resolves to the CheckpointRef', async () => {
    const { engine, record, checkpoint } = fakeEngine();
    const ref = await createCkpt({ engine, runId: RUN }).save({ goal: 'g', next_action: 'n', decisions: ['d'] }, { label: 'milestone' });

    expect(ref).toEqual({ runId: RUN, checkpointId: 'c_1' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith([{ run_id: RUN, type: 'state.declared', actor: 'agent', payload: { goal: 'g', next_action: 'n', decisions: ['d'] } }]);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledWith(RUN, {
      label: 'milestone',
      declaredState: [
        { field: 'goal', value: 'g', origin: 'agent_declared', provenance: provenance('evt_1') },
        { field: 'next_action', value: 'n', origin: 'agent_declared', provenance: provenance('evt_1') },
        { field: 'decision', value: 'd', origin: 'agent_declared', provenance: provenance('evt_1') },
      ],
    });
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(checkpoint.mock.invocationCallOrder[0]!);
  });

  it('passes label null when none is given', async () => {
    const { engine, checkpoint } = fakeEngine();
    await createCkpt({ engine, runId: RUN }).save({ current_step: 's' });
    expect(checkpoint.mock.calls[0]?.[1]).toMatchObject({ label: null });
  });

  it('each save() is a new checkpoint citing its own event', async () => {
    const { engine, checkpoint } = fakeEngine();
    const ckpt = createCkpt({ engine, runId: RUN });
    const first = await ckpt.save({ goal: 'a' });
    const second = await ckpt.save({ goal: 'b' });
    expect([first.checkpointId, second.checkpointId]).toEqual(['c_1', 'c_2']);
    expect(checkpoint.mock.calls.map((call) => (call[1] as { declaredState: Array<{ provenance: { event_ids: string[] } }> }).declaredState[0]?.provenance.event_ids)).toEqual([
      ['evt_1'],
      ['evt_2'],
    ]);
  });

  it('rejects with the Engine error, returning no ref, when checkpointing (including storing the claims) fails', async () => {
    const { engine, checkpoint } = fakeEngine();
    const failure = new Error('projection write failed');
    checkpoint.mockRejectedValueOnce(failure);
    await expect(createCkpt({ engine, runId: RUN }).save({ goal: 'g' })).rejects.toBe(failure);
  });

  it('rejects without checkpointing when record() does not return the state.declared event', async () => {
    const { engine, record, checkpoint } = fakeEngine();
    record.mockResolvedValueOnce([]);
    await expect(createCkpt({ engine, runId: RUN }).save({ goal: 'g' })).rejects.toThrow(/state\.declared/);
    record.mockImplementationOnce(async (drafts) => drafts.map((d) => ({ ...sealed(d, 9), type: 'agent.started' as const })));
    await expect(createCkpt({ engine, runId: RUN }).save({ goal: 'g' })).rejects.toThrow(/state\.declared/);
    expect(checkpoint).toHaveBeenCalledTimes(0);
  });

  it('runs saves one at a time in call order, validates each at call time, and a failed save does not block the next', async () => {
    const { engine, record, checkpoint } = fakeEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    checkpoint.mockImplementationOnce(async (runId: string) => {
      await gate;
      throw new Error('first save fails');
    });
    const ckpt = createCkpt({ engine, runId: RUN });
    const input = { goal: 'second' };
    const first = ckpt.save({ goal: 'first' });
    const second = ckpt.save(input);
    input.goal = 'mutated after save()';

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(record).toHaveBeenCalledTimes(1);
    release();
    await expect(first).rejects.toThrow('first save fails');
    await expect(second).resolves.toEqual({ runId: RUN, checkpointId: 'c_1' });
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]?.[0]).toEqual([{ run_id: RUN, type: 'state.declared', actor: 'agent', payload: { goal: 'second' } }]);
  });

  it.each([
    ['no options', undefined],
    ['no engine', { runId: RUN }],
    ['an engine without checkpoint()', { engine: { record: async () => [] }, runId: RUN }],
    ['an empty runId', { engine: { record: async () => [], checkpoint: async () => ({}) }, runId: '' }],
  ])('createCkpt refuses %s', (_name, options) => {
    expect(() => createCkpt(options as never)).toThrow(TypeError);
  });
});
