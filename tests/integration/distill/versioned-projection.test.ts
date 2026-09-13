/**
 * SPEC-007: re-distilling a checkpoint with another model creates a NEW projection and keeps the earlier
 * one readable; distilling never changes the state blob, the ledger or any checkpoint ref.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { distill, distillRequestFor } from '../../../src/distill/index.js';
import type { Checkpoint } from '../../../src/model/types.js';
import { RECORDED_USAGE, openFixture, type DistillFixture } from './support.js';

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Everything distillation must leave byte-identical. */
async function snapshot(fx: DistillFixture, checkpoint: Checkpoint) {
  const ref = { run_id: fx.runId, checkpoint_id: checkpoint.checkpoint_id };
  const events = await fx.backend.getEvents(fx.runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER });
  const head = events.at(-1)!;
  return {
    stateBlobSha256: sha256(await buffer(await fx.backend.getBlob(checkpoint.state_blob))),
    state: await fx.backend.getState(ref),
    ledgerHead: { seq: head.seq, hash: head.hash },
    ledgerFileSha256: sha256(await readFile(path.join(fx.backend.layout.runs, fx.runId, 'events.jsonl'))),
    checkpoints: await fx.backend.listCheckpoints(fx.runId),
    refs: await fx.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/checkpoints']),
  };
}

describe('versioned projections', () => {
  it('distilling the same checkpoint with two models yields two readable projections and leaves state and ledger byte-identical', async () => {
    const fx = await openFixture();
    try {
      const early = await fx.append('model.requested', { request_id: 'req_1', input_tokens: 120 });
      await fx.append('tool.requested', { tool_call_id: 'tool_1', tool: 'Edit', input: { path: 'src/app.ts' } });
      const c1 = await fx.checkpoint(null, { 'src/app.ts': 'export {};\n' });
      const completed = await fx.append('tool.completed', { tool_call_id: 'tool_1', exit_code: 0 });
      const changed = await fx.append('workspace.changed', { paths: ['src/app.ts'] });
      const c2 = await fx.checkpoint(c1, { 'src/app.ts': 'export const logging = true;\n' }, 'logging-added');

      const haiku = await fx.provider('claude-haiku-4-5-20251001', [
        JSON.stringify({
          claims: [
            {
              field: 'goal',
              value: 'Add request logging',
              confidence: 0.7,
              provenance: { event_ids: [changed.event_id], artifact_refs: [], workspace_paths: ['src/app.ts'], checkpoint_ids: [c1.checkpoint_id] },
            },
            {
              field: 'decision',
              value: 'Cites evidence from before the previous checkpoint',
              provenance: { event_ids: [early.event_id], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] },
            },
          ],
        }),
      ]);
      const sonnet = await fx.provider('claude-sonnet-5', [
        JSON.stringify({
          claims: [
            {
              field: 'next_action',
              value: 'Run the logging tests',
              provenance: { event_ids: [completed.event_id], artifact_refs: [c2.state_hash], workspace_paths: [], checkpoint_ids: [] },
            },
          ],
        }),
      ]);

      const request = distillRequestFor(c2, c1);
      expect(request.ledgerRange).toEqual([c1.ledger_seq, c2.ledger_seq]);
      const before = await snapshot(fx, c2);

      const first = await distill(request, fx.deps(haiku));
      const second = await distill(request, fx.deps(sonnet, first.budget));

      expect(first.projection.id).not.toBe(second.projection.id);
      expect(first.projection.distiller.model).toBe('claude-haiku-4-5-20251001');
      expect(second.projection.distiller.model).toBe('claude-sonnet-5');
      expect(first.rejectedClaims).toBe(1);
      expect(second.rejectedClaims).toBe(0);
      expect(second.budget.spentUsd).toBeCloseTo(2 * RECORDED_USAGE.costUsd, 10);

      await expect(fx.store.get(first.projection.id)).resolves.toEqual(first.projection);
      await expect(fx.store.get(second.projection.id)).resolves.toEqual(second.projection);
      expect((await fx.store.listForCheckpoint(c2.checkpoint_id)).map((projection) => projection.id)).toEqual([
        first.projection.id,
        second.projection.id,
      ]);

      const after = await snapshot(fx, c2);
      expect(after).toEqual(before);
      expect(after.stateBlobSha256).toBe(c2.state_hash);
    } finally {
      await fx.close();
    }
  });
});
