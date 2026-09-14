/**
 * SPEC-012 GET /api/checkpoints/:id: {state, workspace: {commit, changedPaths}, ledger: {range, toolsUsed, modelCalls,
 * sideEffects}}; an unknown id returns 404 with {error}.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { deriveSideEffects } from '../../../src/engine/index.js';
import type { CheckpointPanes } from '../../../src/ui/index.js';
import {
  HEX64,
  UNKNOWN_RUN_ID,
  buildForkFixture,
  checkpointPath,
  openInspector,
  type ForkFixture,
  type InspectorFixture,
} from '../../integration/ui/support.js';

describe('GET /api/checkpoints/:id', () => {
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

  it('returns state, workspace.commit, ledger.range and sideEffects matching the fixture', async () => {
    const res = await ui.request(checkpointPath(fx.c2));
    expect(res.status).toBe(200);
    const panes = res.json as CheckpointPanes;

    // STATE: the stored Agent State Object.
    const at = { run_id: fx.c2.run_id, checkpoint_id: fx.c2.checkpoint_id };
    expect(panes.state).toEqual(await ui.backend.getState(at));
    expect(panes.state).toMatchObject({
      run_id: fx.source.run_id,
      checkpoint_id: 'c_2',
      ledger_seq: fx.c2.ledger_seq,
      workspace_commit: fx.c2.workspace_commit,
    });

    // WORKSPACE: the commit, and what changed since the parent checkpoint.
    expect(panes.workspace).toEqual({ commit: fx.c2.workspace_commit, changedPaths: ['a.txt'] });

    // LEDGER: (c1 cursor, c2 cursor], its tools, model calls and side effects.
    expect(panes.ledger.range).toEqual([fx.c1.ledger_seq, fx.c2.ledger_seq]);
    expect(panes.ledger.sideEffects).toEqual([
      { type: 'email.send', target: 'ops@example.invalid', request_hash: expect.stringMatching(HEX64), response_hash: expect.stringMatching(HEX64), reversibility: 'irreversible' },
    ]);
    const history = await ui.backend.getEvents(fx.source.run_id, { fromSeq: 1, toSeq: fx.c2.ledger_seq });
    expect(panes.ledger.sideEffects).toEqual(deriveSideEffects(history, fx.c1.ledger_seq, fx.c2.ledger_seq));
    expect(panes.ledger.toolsUsed).toEqual(['Edit']);
    expect(panes.ledger.modelCalls).toBe(1);

    const inRange = history.filter((event) => event.seq > fx.c1.ledger_seq);
    expect(panes.ledger.events).toEqual(
      inRange.map((event) => ({ seq: event.seq, type: event.type, actor: event.actor, ts: event.ts, payload: event.payload, payloadRef: null })),
    );
    expect(panes.ledger.events.at(-1)?.type).toBe('checkpoint.created');
  });

  it("a root checkpoint's pane starts its range at 0 and lists its whole tree as changed", async () => {
    const panes = (await ui.request(checkpointPath(fx.c1))).json as CheckpointPanes;
    expect(panes.workspace).toEqual({ commit: fx.c1.workspace_commit, changedPaths: ['a.txt'] });
    expect(panes.ledger.range).toEqual([0, fx.c1.ledger_seq]);
    expect(panes.ledger.toolsUsed).toEqual(['Read']);
    expect(panes.ledger.modelCalls).toBe(1);
    expect(panes.ledger.sideEffects).toEqual([]);
  });

  it("a fork's checkpoints diff against the fork source, then their own parent", async () => {
    const f1 = (await ui.request(checkpointPath(fx.f1))).json as CheckpointPanes;
    expect(f1.workspace).toEqual({ commit: fx.f1.workspace_commit, changedPaths: [] });
    expect(f1.ledger.range).toEqual([0, fx.f1.ledger_seq]);
    expect(f1.state).toMatchObject({ run_id: fx.forked.run_id, checkpoint_id: 'c_1' });

    const f2 = (await ui.request(checkpointPath(fx.f2))).json as CheckpointPanes;
    expect(f2.workspace).toEqual({ commit: fx.f2.workspace_commit, changedPaths: ['b.txt'] });
    expect(f2.ledger.range).toEqual([fx.f1.ledger_seq, fx.f2.ledger_seq]);

    const c3 = (await ui.request(checkpointPath(fx.c3))).json as CheckpointPanes;
    expect(c3.workspace.changedPaths).toEqual(['c.txt']);
  });

  it('an unknown id returns 404 with {error}', async () => {
    for (const id of [`${fx.source.run_id}:c_99`, `${UNKNOWN_RUN_ID}:c_1`, 'c_1', 'nonsense']) {
      const res = await ui.request(`/api/checkpoints/${encodeURIComponent(id)}`);
      expect(res.status, id).toBe(404);
      expect(res.json).toEqual({ error: expect.any(String) });
    }
  });
});
