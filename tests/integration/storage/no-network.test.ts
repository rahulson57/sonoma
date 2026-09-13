/**
 * SPEC-005 "must never send any byte off the machine (no network calls in src/storage/**)".
 *
 * 1. Every outbound network API in this worker is stubbed to throw, then the whole storage surface is
 *    exercised; zero attempts may be recorded.
 * 2. src/storage/** imports no networking module and calls no fetch, so no code path is left unexercised.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, openBackend, sha256 } from './support.js';

const attempts: string[] = [];
const restorers: Array<() => void> = [];

function block<T extends object, K extends keyof T>(target: T, key: K, label: string): void {
  const original = target[key];
  const blocked = function blockedNetworkCall(): never {
    attempts.push(label);
    throw new Error(`network blocked by storage no-network.test.ts: ${label}`);
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

describe('storage with network access stubbed to throw', () => {
  it('the stub is effective', async () => {
    expect(() => net.connect(9, '127.0.0.1')).toThrow(/network blocked/);
    await expect(Promise.resolve().then(() => fetch('http://127.0.0.1:9/'))).rejects.toThrow(/network blocked/);
    expect(() => https.get('https://127.0.0.1:9/')).toThrow(/network blocked/);
    attempts.length = 0;
  });

  it('the full storage surface makes zero network calls', async () => {
    const repo = await tmpGitRepo({ files: { 'a.txt': 'a\n' } });
    try {
      const { backend } = await openBackend(repo.dir);
      const run = await backend.createRun({ agent: 'claude-code' });
      await backend.appendEvent(run.run_id, { type: 'agent.started', actor: 'runtime', payload: {} });
      await backend.appendEvent(run.run_id, { type: 'tool.completed', actor: 'runtime', payload: { stdout: 'n'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1) } });
      const blob = await backend.putBlob(Readable.from([Buffer.from('offline')]));
      expect(blob.sha256).toBe(sha256('offline'));
      await backend.getBlob(blob);
      const c1 = await checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: null }, { 'a.txt': 'b\n' });
      await backend.getCheckpoint(c1);
      await backend.getState(c1);
      await backend.listCheckpoints(run.run_id);
      await backend.getEvents(run.run_id, { fromSeq: 1, toSeq: 10 });
      const forked = await backend.fork(c1);
      await checkpointFiles(backend, { run_id: forked.run_id, parent_checkpoint_id: null }, { 'a.txt': 'c\n' });
      await backend.createChangeDetector(run.run_id, repo.dir).detect(['a.txt']);
      await backend.reindex();
      await backend.close();
      expect(attempts).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('src/storage/** imports no networking module and calls no fetch', async () => {
    const root = fileURLToPath(new URL('../../../src/storage/', import.meta.url));
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

    const forbidden = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:net|tls|http|https|http2|dgram|dns|dns\/promises|undici)['"]/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (forbidden.test(source) || /\bfetch\s*\(/.test(source) || /\bWebSocket\b/.test(source)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
