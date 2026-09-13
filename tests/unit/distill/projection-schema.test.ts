/**
 * SPEC-007: every projection records provider, model, promptVersion, stateHash, ledgerRange and
 * workspaceCommit, and validates against schema/semantic-projection.schema.json.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobProjectionStore, PROMPT_VERSION, distill } from '../../../src/distill/index.js';
import { SCHEMA_FILES, schemaDir, validateAgainst } from '../../../src/model/index.js';
import { COMMIT, MemoryBlobs, START_MS, USAGE, depsFor, fakeRun, provenance, reply, spyProvider } from './support.js';

const RUN = { events: 50, prevCursor: 10, cursor: 30 } as const;

function schemaValid(value: unknown): void {
  const result = validateAgainst('semanticProjection', value);
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

describe('SemanticProjection records its distiller and inputs', () => {
  it('validates against schema/semantic-projection.schema.json, before and after storage', async () => {
    const run = await fakeRun(RUN);
    const claim = { field: 'goal', value: 'g', confidence: 0.5, provenance: provenance({ event_ids: [run.events[14]!.event_id] }) };
    const deps = depsFor(run, spyProvider(reply([claim])));

    const { projection } = await distill(run.request, deps);

    expect(SCHEMA_FILES.semanticProjection).toBe('semantic-projection.schema.json');
    const schema = JSON.parse(readFileSync(path.join(schemaDir(), SCHEMA_FILES.semanticProjection), 'utf8')) as { required: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['distiller', 'input']));
    schemaValid(projection);
    expect(projection).toEqual({
      id: 'proj_1',
      checkpointId: 'c_2',
      distiller: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', promptVersion: PROMPT_VERSION },
      input: { stateHash: run.request.stateHash, ledgerRange: [10, 30], workspaceCommit: COMMIT },
      claims: [{ ...claim, origin: 'distilled' }],
      usage: USAGE,
      createdAt: new Date(START_MS).toISOString(),
    });
    expect(PROMPT_VERSION).toBe('distill-v1');

    const stored = await deps.store.get(projection.id);
    schemaValid(stored);
    expect(stored).toEqual(projection);
  });

  it('records whichever provider and model produced it', async () => {
    const run = await fakeRun(RUN);
    const { projection } = await distill(run.request, depsFor(run, spyProvider(reply([]), { name: 'local', model: 'llama-3.3-70b' })));

    schemaValid(projection);
    expect(projection.distiller).toEqual({ provider: 'local', model: 'llama-3.3-70b', promptVersion: 'distill-v1' });
  });

  it('refuses a provider without a model before calling it', async () => {
    const run = await fakeRun(RUN);
    const provider = spyProvider(reply([]), { model: '' });

    await expect(distill(run.request, depsFor(run, provider))).rejects.toMatchObject({ code: 'DISTILL_INVALID_REQUEST' });
    expect(provider.prompts).toHaveLength(0);
  });

  it('stores nothing when the provider reply is not {"claims": [...]}, and reports the usage spent', async () => {
    const run = await fakeRun(RUN);
    const deps = depsFor(run, spyProvider('I think the goal is to ship.'));

    await expect(distill(run.request, deps)).rejects.toMatchObject({ code: 'DISTILL_INVALID_OUTPUT', usage: USAGE });
    await expect(deps.store.listForCheckpoint('c_2')).resolves.toEqual([]);
  });

  it('refuses a request that does not match the stored checkpoint, before calling the provider', async () => {
    const run = await fakeRun(RUN);
    const provider = spyProvider(reply([]));

    await expect(distill({ ...run.request, stateHash: 'a'.repeat(64) }, depsFor(run, provider))).rejects.toMatchObject({ code: 'DISTILL_INPUT_MISMATCH' });
    await expect(distill({ ...run.request, ledgerRange: [10, 29] }, depsFor(run, provider))).rejects.toMatchObject({ code: 'DISTILL_INPUT_MISMATCH' });
    await expect(distill({ ...run.request, ledgerRange: [31, 30] }, depsFor(run, provider))).rejects.toMatchObject({ code: 'DISTILL_INVALID_REQUEST' });
    expect(provider.prompts).toHaveLength(0);
  });
});

describe('BlobProjectionStore', () => {
  it('refuses a projection that fails the schema, never overwrites one, and reports a missing id', async () => {
    const run = await fakeRun(RUN);
    const { projection } = await distill(run.request, depsFor(run, spyProvider(reply([]))));
    const store = new BlobProjectionStore(new MemoryBlobs());

    await expect(store.put({ ...projection, distiller: { ...projection.distiller, model: '' } })).rejects.toMatchObject({
      code: 'DISTILL_INVALID_PROJECTION',
    });
    await store.put(projection);
    await expect(store.put({ ...projection, claims: [] })).rejects.toMatchObject({ code: 'DISTILL_PROJECTION_EXISTS' });
    await expect(store.get(projection.id)).resolves.toEqual(projection);
    await expect(store.get('proj_missing')).rejects.toMatchObject({ code: 'DISTILL_PROJECTION_NOT_FOUND' });
  });
});
