/**
 * SPEC-001 "Must never: ship a helper that performs network I/O".
 *
 * Blocks outbound sockets for this worker (TCP/TLS connect, UDP send, DNS lookups, fetch), then
 * exercises every helper and asserts it still works and made zero network attempts. Every
 * socket-level API funnels through `net.Socket.prototype.connect`, which is where the block sits;
 * DNS and `fetch` are blocked explicitly as well.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../helpers/clock.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { fakeLedgerEvents } from '../../helpers/ledger.js';
import { recordedProvider } from '../../helpers/providerStub.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';

const attempts: string[] = [];
const restorers: Array<() => void> = [];

function block<T extends object, K extends keyof T>(target: T, key: K, label: string): void {
  const original = target[key];
  const blocked = function blockedNetworkCall(): never {
    attempts.push(label);
    throw new Error(`network blocked by no-network.test.ts: ${label}`);
  };
  Object.defineProperty(target, key, { value: blocked, configurable: true, writable: true });
  restorers.push(() => Object.defineProperty(target, key, { value: original, configurable: true, writable: true }));
}

beforeAll(() => {
  block(net.Socket.prototype, 'connect', 'net.Socket.connect');
  block(dgram.Socket.prototype, 'send', 'dgram.Socket.send');
  block(dgram.Socket.prototype, 'connect', 'dgram.Socket.connect');
  block(dns, 'lookup', 'dns.lookup');
  block(dns, 'resolve', 'dns.resolve');
  block(dns.promises, 'lookup', 'dns.promises.lookup');
  block(dns.promises, 'resolve', 'dns.promises.resolve');
  block(globalThis, 'fetch', 'fetch');
});

afterAll(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

describe('helpers with outbound sockets blocked', () => {
  it('the block is effective', async () => {
    expect(() => net.connect(9, '127.0.0.1')).toThrow(/network blocked/);
    await expect(Promise.resolve().then(() => fetch('http://127.0.0.1:9/'))).rejects.toThrow(/network blocked/);
    await expect(Promise.resolve().then(() => dns.promises.lookup('example.invalid'))).rejects.toThrow(/network blocked/);
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    attempts.length = 0;
  });

  it('tmpGitRepo works and makes no network calls', async () => {
    const repo = await tmpGitRepo({ files: { 'a.txt': 'a\n' } });
    await repo.cleanup();
    expect(attempts).toEqual([]);
  });

  it('secretCorpus, fakeLedgerEvents and fixedClock make no network calls', () => {
    expect(secretCorpus().length).toBeGreaterThan(0);
    expect(fakeLedgerEvents(1000, 3)).toHaveLength(1000);
    const clock = fixedClock(0);
    clock.tick(1);
    expect(clock.now()).toBe(1);
    expect(attempts).toEqual([]);
  });

  it('recordedProvider makes no network calls', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ckpt-nonet-'));
    try {
      const fixture = path.join(dir, 'rec.json');
      const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
      await writeFile(fixture, JSON.stringify({ provider: 'anthropic', model: 'm', responses: [{ text: 'ok', usage }] }));
      await expect(recordedProvider(fixture).complete('p')).resolves.toEqual({ text: 'ok', usage });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(attempts).toEqual([]);
  });
});
