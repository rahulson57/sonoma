/**
 * SPEC-014 envelope invariant / SPEC-002 hard invariant / DEC-006: automatic checkpoints never call an LLM and make
 * no outbound network request.
 *
 * The Checkpoint Engine holds no provider. The only route from a checkpoint to a model is the DistillRequestPort,
 * which the engine uses for LABELLED checkpoints only. Here that port is wired straight to a counting provider, so
 * any distillation an automatic checkpoint triggered would show up as a provider call. Every outbound network API in
 * this worker is stubbed to throw and record the attempt. Nothing on the checkpoint path is stubbed: the real engine,
 * Redaction, ledger and LocalBackend run against a throwaway git repository.
 *
 * A labelled checkpoint at the end is the positive control. It proves the port and the counter are connected, so the
 * zero before it is a measurement rather than a disconnected spy.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// 200 git-backed checkpoints spawn many git processes; the 30 s project default is too tight on a loaded gate.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });
import type { DistillRequest } from '../../../src/distill/index.js';
import type { DistillRequestPort } from '../../../src/engine/index.js';
import type { DistillerProvider } from '../../helpers/providerStub.js';
import { engineFixture, flushImmediates } from '../engine/support.js';

/** SPEC-002's default retention: the whole default envelope of automatic checkpoints for one run. */
const AUTOMATIC_CHECKPOINTS = 200;

const attempts: string[] = [];
const restorers: Array<() => void> = [];

function block<T extends object, K extends keyof T>(target: T, key: K, label: string): void {
  const original = target[key];
  const blocked = function blockedNetworkCall(): never {
    attempts.push(label);
    throw new Error(`network blocked by envelope no-llm-on-checkpoint.test.ts: ${label}`);
  };
  Object.defineProperty(target, key, { value: blocked, configurable: true, writable: true });
  restorers.push(() => Object.defineProperty(target, key, { value: original, configurable: true, writable: true }));
}

beforeAll(() => {
  block(net.Socket.prototype, 'connect', 'net.Socket.connect');
  block(tls, 'connect', 'tls.connect');
  block(dgram.Socket.prototype, 'send', 'dgram.Socket.send');
  block(dgram.Socket.prototype, 'connect', 'dgram.Socket.connect');
  block(dns, 'lookup', 'dns.lookup');
  block(dns, 'resolve', 'dns.resolve');
  block(dns.promises, 'lookup', 'dns.promises.lookup');
  block(dns.promises, 'resolve', 'dns.promises.resolve');
  block(http, 'request', 'http.request');
  block(http, 'get', 'http.get');
  block(https, 'request', 'https.request');
  block(https, 'get', 'https.get');
  block(globalThis, 'fetch', 'fetch');
});

afterAll(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

interface CountingProvider extends DistillerProvider {
  readonly calls: string[];
}

/** A provider that answers locally and counts every completion it is asked for. */
function countingProvider(): CountingProvider {
  const calls: string[] = [];
  return {
    name: 'envelope-counting-provider',
    model: 'none',
    calls,
    async complete(prompt: string) {
      calls.push(prompt);
      return { text: '{}', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
  };
}

describe('automatic checkpoints make no LLM or network call', () => {
  it('the network stub is effective', async () => {
    expect(() => net.connect(9, '127.0.0.1')).toThrow(/network blocked/);
    await expect(Promise.resolve().then(() => fetch('http://127.0.0.1:9/'))).rejects.toThrow(/network blocked/);
    expect(() => https.get('https://127.0.0.1:9/')).toThrow(/network blocked/);
    attempts.length = 0;
  });

  it(`${AUTOMATIC_CHECKPOINTS} automatic checkpoints make 0 provider calls and 0 outbound network requests`, async () => {
    const provider = countingProvider();
    const requests: DistillRequest[] = [];
    const port: DistillRequestPort = {
      request(message) {
        requests.push(message);
        return provider.complete(JSON.stringify(message)).then(() => undefined);
      },
    };
    const fx = await engineFixture({ files: { 'notes.md': 'start\n' }, engine: { distill: port } });
    try {
      const run = await fx.engine.startRun({ agent: 'envelope-no-llm' });

      // A realistic run: tool activity and a workspace change between every automatic checkpoint.
      for (let i = 1; i <= AUTOMATIC_CHECKPOINTS; i += 1) {
        await fx.engine.record([
          { run_id: run.run_id, type: 'tool.requested', actor: 'runtime', intent_id: `toolu_${i}`, payload: { tool_call_id: `toolu_${i}`, tool: 'Edit' } },
          { run_id: run.run_id, type: 'tool.completed', actor: 'runtime', intent_id: `toolu_${i}`, payload: { tool_call_id: `toolu_${i}`, stdout: `edited step ${i}` } },
        ]);
        await writeFile(path.join(fx.repo.dir, 'notes.md'), `step ${i}\n`);
        await fx.engine.checkpoint(run.run_id);
      }
      // A distill request is fire-and-forget after checkpoint() returns: let any such callback run before counting.
      await flushImmediates();

      expect(requests).toEqual([]);
      expect(provider.calls).toEqual([]);
      expect(attempts).toEqual([]);
      const checkpoints = await fx.backend.listCheckpoints(run.run_id);
      expect(checkpoints).toHaveLength(AUTOMATIC_CHECKPOINTS);
      expect(checkpoints.every((cp) => cp.label === null)).toBe(true);

      // Positive control: a labelled checkpoint (an explicit distillation trigger) does reach the counter.
      await fx.engine.checkpoint(run.run_id, { label: 'handoff' });
      await flushImmediates();
      expect(requests).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
      expect(attempts).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });

  it('no module on the checkpoint path imports a network module or provider SDK, calls fetch, or loads the Distiller at runtime', async () => {
    const srcRoot = fileURLToPath(new URL('../../../src/', import.meta.url));
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.name.endsWith('.ts')) files.push(abs);
      }
    };
    for (const module of ['engine', 'storage', 'redact', 'ledger', 'model']) await walk(path.join(srcRoot, module));
    expect(files.length).toBeGreaterThan(20);

    const networkModule = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:net|tls|http|https|http2|dgram|dns|dns\/promises|undici)['"]/;
    const providerSdk = /['"](?:@anthropic-ai\/[^'"]*|openai|@google\/generative-ai)['"]/;
    // `import type` / `export type` from the Distiller is erased at compile time (DEC-030) and allowed.
    const runtimeDistill = [
      /^\s*import\s+(?!type\b)[^;]*?from\s+['"][^'"]*\/distill\/[^'"]*['"]/m,
      /^\s*export\s+(?!type\b)[^;]*?from\s+['"][^'"]*\/distill\/[^'"]*['"]/m,
      /import\s*\(\s*['"][^'"]*\/distill\//,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (
        networkModule.test(source) ||
        providerSdk.test(source) ||
        /\bfetch\s*\(/.test(source) ||
        /\bWebSocket\b/.test(source) ||
        runtimeDistill.some((pattern) => pattern.test(source))
      ) {
        offenders.push(path.relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
