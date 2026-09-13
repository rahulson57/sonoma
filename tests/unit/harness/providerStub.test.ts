import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordedProvider, type ProviderRecording } from '../../helpers/providerStub.js';

let dir: string;
let fixture: string;

const recording: ProviderRecording = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  responses: [
    { text: '{"claims":[]}', usage: { inputTokens: 120, outputTokens: 8, costUsd: 0.0001 } },
    { text: '{"claims":[{"field":"goal"}]}', usage: { inputTokens: 200, outputTokens: 20, costUsd: 0.0002 } },
  ],
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ckpt-providerstub-'));
  fixture = path.join(dir, 'recording.json');
  await writeFile(fixture, JSON.stringify(recording));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('recordedProvider', () => {
  it('replays recorded responses in order and captures prompts', async () => {
    const provider = recordedProvider(fixture);
    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-haiku-4-5-20251001');

    await expect(provider.complete('prompt one')).resolves.toEqual(recording.responses[0]);
    await expect(provider.complete('prompt two')).resolves.toEqual(recording.responses[1]);
    expect(provider.prompts).toEqual(['prompt one', 'prompt two']);
  });

  it('rejects once the recording is exhausted', async () => {
    const provider = recordedProvider(fixture);
    await provider.complete('a');
    await provider.complete('b');
    await expect(provider.complete('c')).rejects.toThrow(/no recorded response/);
  });

  it('fails fast on a missing or malformed fixture', async () => {
    expect(() => recordedProvider(path.join(dir, 'missing.json'))).toThrow(/cannot read fixture/);
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ provider: 'x', model: 'y', responses: [{ text: 1 }] }));
    expect(() => recordedProvider(bad)).toThrow(/responses\[0\]/);
  });
});
