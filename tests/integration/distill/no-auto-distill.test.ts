/**
 * SPEC-007 "Triggers" / DEC-006: automatic checkpoints and plain resume never invoke the distiller.
 *
 * 50 real automatic (unlabeled) checkpoints are created through LocalBackend, and each goes through the
 * distiller's trigger gate as `automatic`. The run is then resumed: the storage half of `ckpt resume`
 * (read the head checkpoint and its Agent State Object) goes through the gate as `resume`. The spy
 * provider's call count must be exactly 0. A labeled checkpoint afterwards must call it exactly once, so
 * the zero is not vacuous.
 *
 * Scope note (SPEC-007 challenge 01a09d1c): the Checkpoint Engine (S05) and the `ckpt resume` CLI (S12)
 * are not part of this slice. They must route their automatic-checkpoint and resume paths through
 * distillForTrigger. The end-to-end assertion through them belongs to the Performance Envelope slice.
 */
import { describe, expect, it, vi } from 'vitest';
// 50 git-backed checkpoints spawn many git processes and fsyncs.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });
import { distillForTrigger, distillRequestFor } from '../../../src/distill/index.js';
import type { Checkpoint } from '../../../src/model/types.js';
import { countingProvider, openFixture } from './support.js';

describe('no automatic distillation', () => {
  it('creates 50 automatic checkpoints and resumes with a spy provider whose call count is exactly 0', async () => {
    const fx = await openFixture();
    try {
      const spy = countingProvider(await fx.provider('claude-haiku-4-5-20251001', ['{"claims":[]}']));
      const deps = fx.deps(spy);

      let previous: Checkpoint | null = null;
      for (let step = 1; step <= 50; step++) {
        await fx.append('tool.completed', { tool_call_id: `tool_${step}`, exit_code: 0, stdout: `step ${step}\n` });
        const checkpoint: Checkpoint = await fx.checkpoint(previous, { 'src/app.ts': `export const step = ${step};\n` });
        expect(checkpoint.label).toBeNull();
        await expect(distillForTrigger('automatic', distillRequestFor(checkpoint, previous), deps)).resolves.toBeNull();
        previous = checkpoint;
      }
      const checkpoints = await fx.backend.listCheckpoints(fx.runId);
      expect(checkpoints).toHaveLength(50);
      expect(checkpoints.every((checkpoint) => checkpoint.label === null)).toBe(true);

      // Plain resume consumes the existing state object of the head checkpoint.
      const head = await fx.backend.getCheckpoint({ run_id: fx.runId, checkpoint_id: 'c_50' });
      const parent = await fx.backend.getCheckpoint({ run_id: fx.runId, checkpoint_id: 'c_49' });
      const state = await fx.backend.getState({ run_id: fx.runId, checkpoint_id: head.checkpoint_id });
      expect(state.ledger_seq).toBe(head.ledger_seq);
      await expect(distillForTrigger('resume', distillRequestFor(head, parent), deps)).resolves.toBeNull();

      expect(spy.calls).toBe(0);
      await expect(fx.store.listForCheckpoint('c_50')).resolves.toEqual([]);

      // Control: an explicit trigger does reach the provider.
      const labeled = await fx.checkpoint(head, { 'src/app.ts': 'export const step = 51;\n' }, 'handoff-ready');
      const result = await distillForTrigger('label', distillRequestFor(labeled, head), deps);
      expect(result?.projection.checkpointId).toBe(labeled.checkpoint_id);
      expect(spy.calls).toBe(1);
    } finally {
      await fx.close();
    }
  });
});
