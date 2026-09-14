/**
 * DEC-039 / DEC-065: `ckpt distill <id>` through main() runs S06's real distill() on a real store:
 * - with tests/helpers/providerStub injected, the stub records exactly 1 call and the projection is stored;
 * - the run budget is read back from stored projections, so an exhausted run refuses before the provider is called;
 * - with the default provider and no ANTHROPIC_API_KEY, it exits 1 before opening the store or constructing an SDK client;
 * - with the default provider and a key, the Anthropic provider asks claude-haiku-4-5 once (SDK mocked, no network).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sdk = vi.hoisted(() => {
  const constructed: unknown[] = [];
  const requests: unknown[] = [];
  const reply = { text: '' };
  class FakeAnthropic {
    readonly messages = {
      create: async (params: unknown) => {
        requests.push(params);
        return {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          container: null,
          stop_details: null,
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: reply.text, citations: null }],
          usage: { input_tokens: 900, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        };
      },
    };
    constructor(options: unknown) {
      constructed.push(options);
    }
  }
  return { constructed, requests, reply, FakeAnthropic };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: sdk.FakeAnthropic }));

import { main, type CliIo, type CliModules } from '../../../src/cli/index.js';
import type { SemanticProjection } from '../../../src/model/types.js';
import { recordedProvider } from '../../helpers/providerStub.js';
import { cliStore, withBackend, type CliStore } from '../../integration/cli/support.js';
import { captureIo } from './support.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GOAL_REPLY = JSON.stringify({
  claims: [{ field: 'goal', value: 'Ship the ckpt CLI', provenance: { event_ids: [], artifact_refs: [], workspace_paths: [], checkpoint_ids: ['c_1'] } }],
});

const stores: CliStore[] = [];

async function twoCheckpoints(): Promise<CliStore> {
  const store = await cliStore(async ({ engine, runId, write }) => {
    await engine.checkpoint(runId);
    await write('app.txt', 'v1\n');
    await engine.checkpoint(runId);
  });
  stores.push(store);
  return store;
}

function projectionsOf(store: CliStore, checkpointId: string): Promise<SemanticProjection[]> {
  return withBackend(store.repo.dir, (backend) => backend.listProjections({ runId: store.runId, checkpointId }));
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.cleanup();
  sdk.constructed.length = 0;
  sdk.requests.length = 0;
});

describe('ckpt distill with a provider (DEC-039)', () => {
  it('runs the real distill() through main() with the recorded provider stub: exactly 1 provider call, projection stored', async () => {
    const store = await twoCheckpoints();
    const stub = recordedProvider(path.join(FIXTURES, 'distill-goal.json'));
    const io = captureIo({ cwd: store.repo.dir });

    const code = await main(['distill', `${store.runId}:c_2`], { io, createProvider: async () => stub });

    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(stub.prompts).toHaveLength(1);
    const projections = await projectionsOf(store, 'c_2');
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      checkpointId: 'c_2',
      source: 'distilled',
      distiller: { provider: 'anthropic-recorded', model: 'claude-haiku-4-5', promptVersion: 'distill-v1' },
      claims: [{ field: 'goal', value: 'Ship the ckpt CLI', origin: 'distilled' }],
      usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.00032 },
    });
    expect(io.out).toContain(`Distilled ${store.runId}:c_2: projection ${projections[0]?.id}`);
  });

  it('reads the run budget back from stored projections: once the run has spent its cap, the next distill exits 1 without calling the provider', async () => {
    const store = await twoCheckpoints();
    const first = recordedProvider(path.join(FIXTURES, 'distill-overspend.json'));
    expect(await main(['distill', `${store.runId}:c_1`], { io: captureIo({ cwd: store.repo.dir }), createProvider: async () => first })).toBe(0);
    expect(first.prompts).toHaveLength(1);

    const second = recordedProvider(path.join(FIXTURES, 'distill-goal.json'));
    const io = captureIo({ cwd: store.repo.dir });
    expect(await main(['distill', `${store.runId}:c_2`], { io, createProvider: async () => second })).toBe(1);
    expect(io.err).toContain('DISTILL_BUDGET_EXCEEDED');
    expect(second.prompts).toEqual([]);
    expect(await projectionsOf(store, 'c_2')).toEqual([]);
  });

  it.each([
    ['unset', {}],
    ['blank', { ANTHROPIC_API_KEY: '   ' }],
  ])('with ANTHROPIC_API_KEY %s, the default provider exits 1 before opening the store or constructing an SDK client', async (_name, env) => {
    const io = captureIo({ env });
    const openModules = vi.fn(async (_io: CliIo): Promise<CliModules> => {
      throw new Error('the store must not be opened');
    });

    const code = await main(['distill', `run_${'0'.repeat(26)}:c_1`], { io, openModules });

    expect(code).toBe(1);
    expect(io.err).toMatch(/^ckpt distill: ANTHROPIC_API_KEY is not set\./);
    expect(openModules).not.toHaveBeenCalled();
    expect(sdk.constructed).toEqual([]);
    expect(sdk.requests).toEqual([]);
  });

  it('with ANTHROPIC_API_KEY set, the default provider is the Anthropic one: one claude-haiku-4-5 request, projection recorded under it', async () => {
    sdk.reply.text = GOAL_REPLY;
    const store = await twoCheckpoints();
    const io = captureIo({ cwd: store.repo.dir, env: { ANTHROPIC_API_KEY: 'test-only-placeholder' } });

    const code = await main(['distill', `${store.runId}:c_2`], { io });

    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(sdk.constructed).toEqual([{ apiKey: 'test-only-placeholder' }]);
    expect(sdk.requests).toHaveLength(1);
    expect(sdk.requests[0]).toMatchObject({ model: 'claude-haiku-4-5', messages: [{ role: 'user' }] });
    const [projection] = await projectionsOf(store, 'c_2');
    expect(projection).toMatchObject({
      source: 'distilled',
      distiller: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      usage: { inputTokens: 900, outputTokens: 100, costUsd: expect.closeTo((900 + 100 * 5) / 1_000_000, 12) },
    });
  });
});
