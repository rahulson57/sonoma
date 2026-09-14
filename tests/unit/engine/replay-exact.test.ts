/**
 * SPEC-006 replay(ref, {exact}): recorded model/tool outputs up to the cursor, without calling a provider or
 * any external API; and SPEC-006 "must never import a provider SDK or perform a network call".
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { CheckpointEngine, isEngineError } from '../../../src/engine/index.js';
import type { StorageBackend } from '../../../src/storage/index.js';
import { allEvents, engineFixture, refOf } from '../../integration/engine/support.js';

const attempts: string[] = [];
const restorers: Array<() => void> = [];

function block<T extends object, K extends keyof T>(target: T, key: K, label: string): void {
  const original = target[key];
  const blocked = function blockedNetworkCall(): never {
    attempts.push(label);
    throw new Error(`network blocked by engine replay-exact.test.ts: ${label}`);
  };
  Object.defineProperty(target, key, { value: blocked, configurable: true, writable: true });
  restorers.push(() => Object.defineProperty(target, key, { value: original, configurable: true, writable: true }));
}

beforeAll(() => {
  block(net.Socket.prototype, 'connect', 'net.Socket.connect');
  block(tls, 'connect', 'tls.connect');
  block(dgram.Socket.prototype, 'send', 'dgram.Socket.send');
  block(dns, 'lookup', 'dns.lookup');
  block(dns.promises, 'lookup', 'dns.promises.lookup');
  block(http, 'request', 'http.request');
  block(https, 'request', 'https.request');
  block(globalThis, 'fetch', 'fetch');
});

afterAll(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

function spyProvider() {
  return { name: 'spy', model: 'claude-haiku-4-5-20251001', complete: vi.fn(async (_prompt: string) => ({ text: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })) };
}

describe('replay(ref, {exact: true})', () => {
  it('the network stub is effective', async () => {
    expect(() => net.connect(9, '127.0.0.1')).toThrow(/network blocked/);
    await expect(Promise.resolve().then(() => fetch('http://127.0.0.1:9/'))).rejects.toThrow(/network blocked/);
    attempts.length = 0;
  });

  it('returns recorded outputs with a network stub that throws and a provider spy count of 0', async () => {
    const provider = spyProvider();
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' }, engine: { distill: { request: () => void provider.complete('distill') } } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const id = run.run_id;
      const recorded = await fx.engine.record([
        { run_id: id, type: 'model.requested', actor: 'agent', payload: { request_id: 'req_1', prompt: 'List the files.' } },
        { run_id: id, type: 'model.responded', actor: 'runtime', payload: { request_id: 'req_1', text: 'I will run ls.', usage: { input_tokens: 12, output_tokens: 6 } } },
        { run_id: id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_1', tool: 'Bash', input: { command: 'ls' } } },
        { run_id: id, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_1', stdout: 'a.txt\n', stderr: '', exit_code: 0 } },
      ]);
      const c1 = await fx.engine.checkpoint(id);
      await fx.engine.record([{ run_id: id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_2', tool: 'Bash', input: { command: 'make' } } }]);

      const replayed = await fx.engine.replay(refOf(c1), { exact: true });

      expect(replayed.map((event) => event.seq)).toEqual(Array.from({ length: c1.ledger_seq }, (_, i) => i + 1));
      expect(replayed.at(-1)).toMatchObject({ type: 'checkpoint.created', seq: c1.ledger_seq });
      expect(replayed.slice(1, 5)).toEqual(recorded);
      expect(replayed.find((event) => event.type === 'model.responded')?.payload).toMatchObject({ text: 'I will run ls.' });
      expect(replayed.find((event) => event.type === 'tool.completed')?.payload).toMatchObject({ stdout: 'a.txt\n', exit_code: 0 });
      expect(replayed.some((event) => event.payload?.['tool_call_id'] === 'call_2')).toBe(false);
      expect(replayed).toEqual((await allEvents(fx.backend, id)).slice(0, c1.ledger_seq));

      expect(attempts).toEqual([]);
      expect(provider.complete).toHaveBeenCalledTimes(0);
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects a ledger whose recorded outputs were altered, while non-exact replay returns the events as read', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      await fx.engine.record([
        { run_id: run.run_id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_1', tool: 'Bash' } },
        { run_id: run.run_id, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_1', stdout: 'real\n' } },
      ]);
      const c1 = await fx.engine.checkpoint(run.run_id);

      const b = fx.backend;
      const forging: StorageBackend = {
        createRun: (input) => b.createRun(input),
        appendEvent: (runId, event) => b.appendEvent(runId, event),
        getEvents: async (runId, range) =>
          (await b.getEvents(runId, range)).map((event) =>
            event.type === 'tool.completed' ? { ...event, payload: { ...event.payload, stdout: 'forged\n' } } : event,
          ),
        putBlob: (data) => b.putBlob(data),
        getBlob: (ref) => b.getBlob(ref),
        createCheckpoint: (input) => b.createCheckpoint(input),
        getCheckpoint: (ref) => b.getCheckpoint(ref),
        listCheckpoints: (runId) => b.listCheckpoints(runId),
        getState: (ref) => b.getState(ref),
        fork: (ref) => b.fork(ref),
        reindex: () => b.reindex(),
      };
      const engine = await CheckpointEngine.open({ backend: forging, repoDir: fx.repo.dir });

      await expect(engine.replay(refOf(c1), { exact: true })).rejects.toSatisfy((err: unknown) => isEngineError(err, 'ERR_CORRUPT'));
      const loose = await engine.replay(refOf(c1), { exact: false });
      expect(loose.find((event) => event.type === 'tool.completed')?.payload).toMatchObject({ stdout: 'forged\n' });
      expect(attempts).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });

  it('src/engine/** imports no provider SDK or networking module and calls no fetch', async () => {
    const root = fileURLToPath(new URL('../../../src/engine/', import.meta.url));
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.name.endsWith('.ts')) files.push(abs);
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThan(5);

    const networking = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:net|tls|http|https|http2|dgram|dns|dns\/promises|undici)['"]/;
    const providerSdk = /['"](?:@anthropic-ai\/[^'"]*|openai|@google\/generative-ai|@aws-sdk\/[^'"]*|[^'"]*\/distill\/[^'"]*)['"]/;
    // DEC-030: a whole-statement `import type { … } from '…/distill/…'` is erased at compile time, so it is the one
    // allowed reference to the Distiller. `import { type X }` still leaves a runtime import behind and is refused.
    const typeOnlyDistillImport = /^import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*\/distill\/[^'"]*['"];?[ \t]*$/gm;
    const scrub = (source: string): string => source.replace(typeOnlyDistillImport, '');
    expect(providerSdk.test(scrub(`import type { DistillRequest } from '../distill/index.js';`))).toBe(false);
    expect(providerSdk.test(scrub(`import { distill } from '../distill/index.js';`))).toBe(true);
    expect(providerSdk.test(scrub(`import { type DistillRequest } from '../distill/index.js';`))).toBe(true);
    expect(providerSdk.test(scrub(`const d = await import('../distill/index.js');`))).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      const source = scrub(await readFile(file, 'utf8'));
      if (networking.test(source) || providerSdk.test(source) || /\bfetch\s*\(/.test(source) || /\bWebSocket\b/.test(source)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
