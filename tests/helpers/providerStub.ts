/**
 * Recorded distiller provider stub (SPEC-001 "Network": the distiller is tested against a
 * recorded provider, never a live API).
 *
 * ─── PLACEHOLDER TYPE ─────────────────────────────────────────────────────────────────────────
 * `DistillerProvider` is owned by S06 (Distiller, SPEC-007, `src/distill/**`), which has not
 * landed. The interface below mirrors SPEC-007's published contract and nothing more. When S06
 * lands, replace it with an import from `src/distill`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** PLACEHOLDER for S06's DistillerProvider — see the file header. */
export interface DistillerProvider {
  name: string;
  model: string;
  complete(prompt: string): Promise<{ text: string; usage: ProviderUsage }>;
}

/** On-disk recording format read by `recordedProvider`. */
export interface ProviderRecording {
  provider: string;
  model: string;
  /** Replayed in order, one per `complete()` call. */
  responses: Array<{ text: string; usage: ProviderUsage }>;
}

export interface RecordedProvider extends DistillerProvider {
  /** Every prompt passed to `complete()`, in call order — for asserting what was sent. */
  readonly prompts: readonly string[];
}

function fail(fixture: string, message: string): never {
  throw new Error(`recordedProvider(${fixture}): ${message}`);
}

function isUsage(value: unknown): value is ProviderUsage {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  return ['inputTokens', 'outputTokens', 'costUsd'].every((k) => typeof u[k] === 'number' && Number.isFinite(u[k]));
}

function parseRecording(fixture: string, raw: string): ProviderRecording {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(fixture, `not valid JSON (${(err as Error).message})`);
  }
  if (typeof data !== 'object' || data === null) fail(fixture, 'recording must be a JSON object');
  const rec = data as Record<string, unknown>;
  if (typeof rec.provider !== 'string' || typeof rec.model !== 'string') {
    fail(fixture, 'recording needs string "provider" and "model"');
  }
  if (!Array.isArray(rec.responses)) fail(fixture, 'recording needs a "responses" array');
  rec.responses.forEach((r: unknown, i: number) => {
    const entry = r as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null || typeof entry.text !== 'string' || !isUsage(entry.usage)) {
      fail(fixture, `responses[${i}] needs "text" (string) and "usage" {inputTokens, outputTokens, costUsd}`);
    }
  });
  return data as ProviderRecording;
}

/**
 * Load a recording from `fixture` (a JSON file path, resolved against the current working
 * directory) and return a provider that replays its responses in order. No network I/O: the
 * only side effect is reading the fixture file once, synchronously, at construction.
 */
export function recordedProvider(fixture: string): RecordedProvider {
  const file = path.resolve(fixture);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    fail(fixture, `cannot read fixture (${(err as Error).message})`);
  }
  const recording = parseRecording(fixture, raw);
  const prompts: string[] = [];
  return {
    name: recording.provider,
    model: recording.model,
    prompts,
    async complete(prompt: string) {
      const index = prompts.length;
      prompts.push(prompt);
      const response = recording.responses[index];
      if (!response) {
        fail(fixture, `complete() call #${index + 1} has no recorded response (recording has ${recording.responses.length})`);
      }
      return { text: response.text, usage: { ...response.usage } };
    },
  };
}
