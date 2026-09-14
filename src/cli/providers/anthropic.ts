/**
 * The concrete Anthropic DistillerProvider (DEC-039, DEC-065). src/distill stays provider-agnostic, so the binding lives
 * at the composition root. This is the only file that imports @anthropic-ai/sdk (tests/unit/cli/thin-imports.test.ts).
 * main() loads it with a dynamic import inside `ckpt distill` only, so no other command loads or constructs it.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DistillerProvider, ProviderUsage } from '../../distill/index.js';

export const ANTHROPIC_PROVIDER_NAME = 'anthropic';

/** DEC-039: no date suffix, passed explicitly rather than read from src/distill's DEFAULT_MODEL. */
export const DISTILL_MODEL = 'claude-haiku-4-5';

/** Upper bound on the reply. A distillation is a short `{"claims": [...]}` document; this only guards a runaway reply. */
export const DISTILL_MAX_TOKENS = 16_000;

/** First-party API list prices in USD per million tokens, used to compute ProviderUsage.costUsd for the run budget. */
export const PRICING_USD_PER_MTOK: Readonly<Record<string, { readonly input: number; readonly output: number }>> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Cache writes and reads are billed at these multiples of the input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** The one SDK call the provider makes. An `Anthropic` client satisfies it; tests inject a fake. */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message>;
  };
}

export interface AnthropicProviderOptions {
  /** Injected client (tests). When absent, an `Anthropic` client is constructed with `apiKey`. */
  readonly client?: AnthropicMessagesClient;
  readonly apiKey?: string;
  readonly model?: string;
}

function usageOf(usage: Anthropic.Usage, price: { readonly input: number; readonly output: number }): ProviderUsage {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputCost = usage.input_tokens + cacheWrite * CACHE_WRITE_MULTIPLIER + cacheRead * CACHE_READ_MULTIPLIER;
  return {
    inputTokens: usage.input_tokens + cacheWrite + cacheRead,
    outputTokens: usage.output_tokens,
    costUsd: (inputCost * price.input + usage.output_tokens * price.output) / 1_000_000,
  };
}

function replyText(message: Anthropic.Message, model: string): string {
  if (message.stop_reason === 'refusal') throw new Error(`${model} declined to distill this checkpoint (stop_reason refusal)`);
  if (message.stop_reason === 'max_tokens') throw new Error(`${model} reply was cut off at max_tokens ${DISTILL_MAX_TOKENS}`);
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): DistillerProvider {
  const model = options.model ?? DISTILL_MODEL;
  const price = PRICING_USD_PER_MTOK[model];
  if (price === undefined) throw new TypeError(`no pricing for model ${JSON.stringify(model)}: the run budget needs a cost for every call`);
  const client: AnthropicMessagesClient = options.client ?? new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
  return {
    name: ANTHROPIC_PROVIDER_NAME,
    model,
    async complete(prompt: string) {
      const message = await client.messages.create({
        model,
        max_tokens: DISTILL_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      });
      return { text: replyText(message, model), usage: usageOf(message.usage, price) };
    },
  };
}
