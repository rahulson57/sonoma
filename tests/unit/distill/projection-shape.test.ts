/**
 * SPEC-007 / SPEC-015 amendment 3: every projection the Distiller writes has source 'distilled' with non-null
 * distiller and usage, and a 'declared' projection with null distiller and usage passes the very same validator.
 */
import { describe, expect, it } from 'vitest';
import { BlobProjectionStore, PROMPT_VERSION, distill } from '../../../src/distill/index.js';
import type { SemanticProjection } from '../../../src/model/types.js';
import { validateSemanticProjection } from '../../../src/model/validate.js';
import { COMMIT, MemoryBlobs, depsFor, fakeRun, provenance, reply, spyProvider } from './support.js';

const RUN = { events: 40, prevCursor: 8, cursor: 24 } as const;

describe('projection shape: source, distiller and usage', () => {
  it("every projection the Distiller writes has source 'distilled' with non-null distiller and usage", async () => {
    const run = await fakeRun(RUN);
    const evidence = run.events.find((event) => event.seq === 13)!.event_id;
    const providers = [
      spyProvider(reply([{ field: 'goal', value: 'Ship S14', provenance: provenance({ event_ids: [evidence] }) }])),
      spyProvider(reply([]), { name: 'local', model: 'llama-3.3-70b', usage: { inputTokens: 5, outputTokens: 1, costUsd: 0 } }),
    ];
    const deps = depsFor(run, providers[0]!);

    for (const provider of providers) {
      const { projection } = await distill(run.request, { ...deps, provider });
      expect(projection.source).toBe('distilled');
      expect(projection.distiller).toEqual({ provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION });
      expect(projection.usage).not.toBeNull();
      expect(validateSemanticProjection(projection).ok).toBe(true);
      await expect(deps.store.get(projection.id)).resolves.toMatchObject({ source: 'distilled', distiller: projection.distiller, usage: projection.usage });
    }
    const stored = await deps.store.listForCheckpoint('c_2');
    expect(stored).toHaveLength(2);
    expect(stored.every((projection) => projection.source === 'distilled' && projection.distiller !== null && projection.usage !== null)).toBe(true);
  });

  it("a projection with source 'declared' and null distiller/usage passes the same validator, and the store keeps it", async () => {
    const run = await fakeRun(RUN);
    const declared: SemanticProjection = {
      id: 'proj_declared_1',
      checkpointId: 'c_2',
      source: 'declared',
      distiller: null,
      input: { stateHash: run.request.stateHash, ledgerRange: [8, 24], workspaceCommit: COMMIT },
      claims: [{ field: 'goal', value: 'Ship S14', origin: 'agent_declared', provenance: provenance({ event_ids: [run.events[20]!.event_id] }) }],
      usage: null,
      createdAt: '2026-09-14T03:00:00.000Z',
    };

    expect(validateSemanticProjection(declared)).toEqual({ ok: true, value: declared });
    const store = new BlobProjectionStore(new MemoryBlobs());
    await store.put(declared);
    await expect(store.get(declared.id)).resolves.toEqual(declared);
  });

  it("the same validator refuses source 'distilled' with a null distiller or usage, and the store persists neither", async () => {
    const run = await fakeRun(RUN);
    const { projection } = await distill(run.request, depsFor(run, spyProvider(reply([]))));
    const store = new BlobProjectionStore(new MemoryBlobs());

    for (const bad of [{ ...projection, distiller: null }, { ...projection, usage: null }]) {
      expect(validateSemanticProjection(bad).ok).toBe(false);
      await expect(store.put(bad)).rejects.toMatchObject({ code: 'DISTILL_INVALID_PROJECTION' });
    }
    await expect(store.listForCheckpoint('c_2')).resolves.toEqual([]);
  });
});
