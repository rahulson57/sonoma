/**
 * DEC-039 / DEC-065: the concrete Anthropic DistillerProvider, exercised with an injected fake SDK client (no network).
 * Checks: one claude-haiku-4-5 request carrying the prompt; the text reply maps to S06's `complete()` result; usage and
 * cost map to ProviderUsage; refusals and truncated replies reject. Without an injected client, the SDK client is
 * constructed with the given key (the SDK module is mocked) and nothing is sent at construction.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const constructed: unknown[] = [];
  class FakeAnthropic {
    readonly messages = {
      create: (): never => {
        throw new Error('a constructed SDK client must not send anything in this test');
      },
    };
    constructor(options: unknown) {
      constructed.push(options);
    }
  }
  return { constructed, FakeAnthropic };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: sdk.FakeAnthropic }));

import {
  ANTHROPIC_PROVIDER_NAME,
  DISTILL_MAX_TOKENS,
  DISTILL_MODEL,
  createAnthropicProvider,
  type AnthropicMessagesClient,
} from '../../../src/cli/providers/anthropic.js';
import type { DistillerProvider } from '../../../src/distill/index.js';

function reply(fields: { content?: unknown[]; stop_reason?: Anthropic.StopReason | null; usage?: Partial<Anthropic.Usage> } = {}): Anthropic.Message {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: DISTILL_MODEL,
    container: null,
    stop_details: null,
    stop_reason: fields.stop_reason === undefined ? 'end_turn' : fields.stop_reason,
    stop_sequence: null,
    content: fields.content ?? [{ type: 'text', text: '{"claims": []}', citations: null }],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      ...fields.usage,
    },
  } as unknown as Anthropic.Message;
}

function fakeClient(message: Anthropic.Message) {
  const create = vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming) => message);
  const client: AnthropicMessagesClient = { messages: { create } };
  return { client, create };
}

beforeEach(() => {
  sdk.constructed.length = 0;
});

describe('createAnthropicProvider (DEC-039)', () => {
  it("defaults to model 'claude-haiku-4-5' with no date suffix, named 'anthropic'", () => {
    const provider: DistillerProvider = createAnthropicProvider({ client: fakeClient(reply()).client });
    expect(DISTILL_MODEL).toBe('claude-haiku-4-5');
    expect(provider.model).toBe('claude-haiku-4-5');
    expect(provider.name).toBe(ANTHROPIC_PROVIDER_NAME);
    expect(provider.name).toBe('anthropic');
  });

  it('complete(prompt) sends exactly one claude-haiku-4-5 request carrying the prompt and returns the reply text', async () => {
    const { client, create } = fakeClient(reply());
    const result = await createAnthropicProvider({ client }).complete('DISTILL THIS CHECKPOINT');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5',
      max_tokens: DISTILL_MAX_TOKENS,
      messages: [{ role: 'user', content: 'DISTILL THIS CHECKPOINT' }],
    });
    expect(result.text).toBe('{"claims": []}');
  });

  it('joins the text blocks of the reply and ignores other block types', async () => {
    const message = reply({
      content: [
        { type: 'thinking', thinking: 'weighing the ledger delta', signature: 'sig' },
        { type: 'text', text: '{"claims":', citations: null },
        { type: 'text', text: ' []}', citations: null },
      ],
    });
    const result = await createAnthropicProvider({ client: fakeClient(message).client }).complete('p');
    expect(result.text).toBe('{"claims": []}');
  });

  it("maps the SDK usage to S06's ProviderUsage, costed at claude-haiku-4-5 prices ($1 / $5 per million tokens)", async () => {
    const result = await createAnthropicProvider({ client: fakeClient(reply({ usage: { input_tokens: 1200, output_tokens: 300 } })).client }).complete('p');
    expect(result.usage.inputTokens).toBe(1200);
    expect(result.usage.outputTokens).toBe(300);
    expect(result.usage.costUsd).toBeCloseTo((1200 * 1 + 300 * 5) / 1_000_000, 12);
  });

  it('counts cache writes and reads as input tokens, costed at 1.25x and 0.1x the input price', async () => {
    const usage = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10_000, output_tokens: 50 };
    const result = await createAnthropicProvider({ client: fakeClient(reply({ usage })).client }).complete('p');
    expect(result.usage.inputTokens).toBe(11_100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.costUsd).toBeCloseTo((100 + 1000 * 1.25 + 10_000 * 0.1 + 50 * 5) / 1_000_000, 12);
  });

  it.each([
    ['refusal', /declined/],
    ['max_tokens', /cut off/],
  ] as const)('rejects a reply that stopped with %s instead of returning partial claims', async (stopReason, message) => {
    const provider = createAnthropicProvider({ client: fakeClient(reply({ stop_reason: stopReason })).client });
    await expect(provider.complete('p')).rejects.toThrow(message);
  });

  it('refuses a model it has no price for, because the run budget needs a cost for every call', () => {
    expect(() => createAnthropicProvider({ client: fakeClient(reply()).client, model: 'claude-unpriced-model' })).toThrow(TypeError);
  });

  it('without an injected client, constructs the SDK client with the given key and sends nothing at construction', () => {
    const provider = createAnthropicProvider({ apiKey: 'test-only-placeholder' });
    expect(sdk.constructed).toEqual([{ apiKey: 'test-only-placeholder' }]);
    expect(provider.model).toBe('claude-haiku-4-5');
  });
});
