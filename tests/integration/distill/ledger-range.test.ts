/**
 * SPEC-007 "Input bounding" on a real LocalBackend store: a request's ledgerRange must start at the parent
 * checkpoint's cursor (0 for a run's first checkpoint). A caller can neither widen it towards the full run
 * trajectory nor narrow it, and the provider is never called for such a request.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { DEFAULT_MODEL, distill, distillRequestFor } from '../../../src/distill/index.js';
import { countingProvider, openFixture } from './support.js';

function cite(eventId: string, value: string) {
  return { field: 'decision', value, provenance: { event_ids: [eventId], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] } };
}

describe('ledgerRange lower bound', () => {
  it('refuses a range that does not start at the parent checkpoint cursor, and accepts the one that does', async () => {
    const fx = await openFixture();
    try {
      const early = await fx.append('model.requested', { request_id: 'req_1', input_tokens: 120 });
      const c1 = await fx.checkpoint(null, { 'src/app.ts': 'export {};\n' });
      const changed = await fx.append('workspace.changed', { paths: ['src/app.ts'] });
      await fx.append('model.requested', { request_id: 'req_2', input_tokens: 80 });
      const c2 = await fx.checkpoint(c1, { 'src/app.ts': 'export const x = 1;\n' }, 'label');
      expect(c1.ledger_seq).toBeGreaterThanOrEqual(early.seq);
      expect(c2.ledger_seq).toBeGreaterThan(c1.ledger_seq);

      const provider = countingProvider(
        await fx.provider(DEFAULT_MODEL, [JSON.stringify({ claims: [cite(early.event_id, 'from before c1'), cite(changed.event_id, 'from the delta')] })]),
      );
      const request = distillRequestFor(c2, c1);

      // Widened (0 would send the whole run) or narrowed past the parent's cursor.
      for (const from of [0, c1.ledger_seq - 1, c1.ledger_seq + 1, c2.ledger_seq]) {
        await expect(distill({ ...request, ledgerRange: [from, c2.ledger_seq] }, fx.deps(provider))).rejects.toMatchObject({
          code: 'DISTILL_INPUT_MISMATCH',
        });
      }
      // The first checkpoint of a run starts at 0.
      await expect(distill({ ...distillRequestFor(c1, null), ledgerRange: [1, c1.ledger_seq] }, fx.deps(provider))).rejects.toMatchObject({
        code: 'DISTILL_INPUT_MISMATCH',
      });
      expect(provider.calls).toBe(0);

      const result = await distill(request, fx.deps(provider));

      expect(provider.calls).toBe(1);
      expect(result.projection.input.ledgerRange).toEqual([c1.ledger_seq, c2.ledger_seq]);
      expect(result.rejectedClaims).toBe(1);
      expect(result.projection.claims.map((claim) => claim.value)).toEqual(['from the delta']);
    } finally {
      await fx.close();
    }
  });
});
