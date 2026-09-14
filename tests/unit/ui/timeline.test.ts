/**
 * SPEC-012 GET /api/runs/:runId/checkpoints: TimelineNode[] ordered by createdAt, with parentId for fork lineage.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import type { TimelineNode } from '../../../src/ui/index.js';
import { UNKNOWN_RUN_ID, buildForkFixture, openInspector, refText, type ForkFixture, type InspectorFixture } from '../../integration/ui/support.js';

describe('GET /api/runs/:runId/checkpoints', () => {
  let fx: ForkFixture;
  let ui: InspectorFixture;

  beforeAll(async () => {
    fx = await buildForkFixture();
    ui = await openInspector(fx.repo.dir);
  });

  afterAll(async () => {
    await ui?.close();
    await fx?.cleanup();
  });

  it('for a run with a fork returns nodes whose parentId values reproduce the fork lineage of the fixture', async () => {
    const res = await ui.request(`/api/runs/${fx.source.run_id}/checkpoints`);
    expect(res.status).toBe(200);
    const nodes = res.json as TimelineNode[];

    const src = fx.source.run_id;
    const fork = fx.forked.run_id;
    expect(fx.forked).toMatchObject({ parent_run_id: src, forked_from_checkpoint: 'c_2' });
    expect(nodes).toEqual([
      { checkpointId: refText(fx.c1), parentId: null, runId: src, label: null, createdAt: fx.c1.created_at, ledgerRange: [0, fx.c1.ledger_seq] },
      { checkpointId: refText(fx.c2), parentId: refText(fx.c1), runId: src, label: 'edited', createdAt: fx.c2.created_at, ledgerRange: [fx.c1.ledger_seq, fx.c2.ledger_seq] },
      { checkpointId: refText(fx.c3), parentId: refText(fx.c2), runId: src, label: null, createdAt: fx.c3.created_at, ledgerRange: [fx.c2.ledger_seq, fx.c3.ledger_seq] },
      // The fork's first checkpoint has no same-run parent: its parent is the checkpoint it was forked from.
      { checkpointId: refText(fx.f1), parentId: refText(fx.c2), runId: fork, label: null, createdAt: fx.f1.created_at, ledgerRange: [0, fx.f1.ledger_seq] },
      { checkpointId: refText(fx.f2), parentId: refText(fx.f1), runId: fork, label: null, createdAt: fx.f2.created_at, ledgerRange: [fx.f1.ledger_seq, fx.f2.ledger_seq] },
    ]);

    // Walking parentId from the fork's head reaches the source run's root through the fork point.
    const byId = new Map(nodes.map((node) => [node.checkpointId, node]));
    const chain: string[] = [];
    for (let id: string | null = refText(fx.f2); id !== null; id = byId.get(id)?.parentId ?? null) chain.push(id);
    expect(chain).toEqual([refText(fx.f2), refText(fx.f1), refText(fx.c2), refText(fx.c1)]);
  });

  it("a forked run's own timeline links its first checkpoint to the source checkpoint", async () => {
    const res = await ui.request(`/api/runs/${fx.forked.run_id}/checkpoints`);
    expect(res.status).toBe(200);
    expect((res.json as TimelineNode[]).map((node) => [node.checkpointId, node.parentId])).toEqual([
      [refText(fx.f1), refText(fx.c2)],
      [refText(fx.f2), refText(fx.f1)],
    ]);
  });

  it('orders nodes by createdAt', async () => {
    const nodes = (await ui.request(`/api/runs/${fx.source.run_id}/checkpoints`)).json as TimelineNode[];
    const times = nodes.map((node) => Date.parse(node.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(nodes.length);
  });

  it('an unknown or malformed run id returns 404 with {error}', async () => {
    for (const runId of [UNKNOWN_RUN_ID, 'not-a-run']) {
      const res = await ui.request(`/api/runs/${runId}/checkpoints`);
      expect(res.status, runId).toBe(404);
      expect(res.json).toEqual({ error: expect.any(String) });
    }
  });

  it('GET /api/runs returns Run[] including the fork', async () => {
    const res = await ui.request('/api/runs');
    expect(res.status).toBe(200);
    expect(res.json).toEqual([fx.source, fx.forked]);
  });
});
