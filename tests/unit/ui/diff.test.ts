/**
 * SPEC-012 GET /api/diff?a=&b=: the Checkpoint Engine's `diff(a, b)` (state, workspace, ledger, side-effect diffs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import type { Checkpoint } from '../../../src/model/types.js';
import { UNKNOWN_RUN_ID, buildForkFixture, diffPath, engineRef, openInspector, refText, type ForkFixture, type InspectorFixture } from '../../integration/ui/support.js';

describe('GET /api/diff?a=&b=', () => {
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

  it('returns JSON deep-equal to Checkpoint Engine diff(a, b)', async () => {
    const pairs: Array<[Checkpoint, Checkpoint]> = [
      [fx.c1, fx.c2],
      [fx.c2, fx.c1],
      [fx.c1, fx.c3],
      [fx.c3, fx.f2],
      [fx.f2, fx.c1],
      [fx.f1, fx.f1],
    ];
    for (const [a, b] of pairs) {
      const res = await ui.request(diffPath(a, b));
      expect(res.status, `${refText(a)} .. ${refText(b)}`).toBe(200);
      const expected: unknown = JSON.parse(JSON.stringify(await ui.engine.diff(engineRef(a), engineRef(b))));
      expect(res.json, `${refText(a)} .. ${refText(b)}`).toStrictEqual(expected);
    }

    // Not vacuous: c1 → c2 has all four parts.
    const diff = (await ui.request(diffPath(fx.c1, fx.c2))).json as {
      state: unknown[];
      workspace: Array<{ status: string; path: string }>;
      ledger: { a: [number, number]; b: [number, number] };
      sideEffects: Array<{ type: string }>;
    };
    expect(diff.state.length).toBeGreaterThan(0);
    expect(diff.workspace).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect(diff.ledger).toEqual({ a: [fx.c1.ledger_seq, fx.c1.ledger_seq], b: [fx.c1.ledger_seq, fx.c2.ledger_seq] });
    expect(diff.sideEffects.map((effect) => effect.type)).toEqual(['email.send']);
  });

  it('a missing a or b returns 400 with {error}', async () => {
    for (const query of ['', `?a=${encodeURIComponent(refText(fx.c1))}`, `?b=${encodeURIComponent(refText(fx.c1))}`, '?a=&b=']) {
      const res = await ui.request(`/api/diff${query}`);
      expect(res.status, query).toBe(400);
      expect(res.json).toEqual({ error: expect.any(String) });
    }
  });

  it('an unknown checkpoint returns 404 with {error}', async () => {
    for (const other of [`${UNKNOWN_RUN_ID}:c_1`, `${fx.source.run_id}:c_99`, 'nonsense']) {
      const res = await ui.request(`/api/diff?a=${encodeURIComponent(refText(fx.c1))}&b=${encodeURIComponent(other)}`);
      expect(res.status, other).toBe(404);
      expect(res.json).toEqual({ error: expect.any(String) });
    }
  });
});
