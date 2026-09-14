/**
 * SPEC-012 "Bind to any address other than 127.0.0.1 by default" is never allowed: startInspector() with defaults
 * listens on 127.0.0.1:7420 and on no other address.
 */
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { CheckpointEngine } from '../../../src/engine/index.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { DEFAULT_HOST, DEFAULT_PORT, readRunRecords, startInspector } from '../../../src/ui/index.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

/** `connected`, or why a TCP connection to host:port did not open. */
function connectOutcome(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
  });
}

function statusWithHostHeader(port: number, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/runs', headers: { host: hostHeader } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startInspector() binding', () => {
  let repo: TmpGitRepo;
  let backend: LocalBackend;
  let engine: CheckpointEngine;

  beforeAll(async () => {
    repo = await tmpGitRepo({ files: { 'a.txt': 'a\n' } });
    backend = await LocalBackend.open({ repoDir: repo.dir });
    engine = await CheckpointEngine.open({ backend, repoDir: repo.dir });
  });

  afterAll(async () => {
    await backend?.close();
    await repo?.cleanup();
  });

  it('with defaults listens on 127.0.0.1:7420 and not on 0.0.0.0', async () => {
    expect([DEFAULT_HOST, DEFAULT_PORT]).toEqual(['127.0.0.1', 7420]);
    const inspector = await startInspector({ backend, engine, listRuns: () => readRunRecords(backend.layout.runs) });
    try {
      expect(inspector.url).toBe('http://127.0.0.1:7420/');
      expect(await connectOutcome('127.0.0.1', 7420)).toBe('connected');
      const res = await fetch('http://127.0.0.1:7420/api/runs');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);

      // A wildcard (0.0.0.0) listener would also accept on every other local address; this one accepts on none.
      const otherAddresses = Object.values(os.networkInterfaces())
        .flatMap((list) => list ?? [])
        .filter((iface) => iface.family === 'IPv4' && iface.address !== '127.0.0.1')
        .map((iface) => iface.address);
      for (const address of otherAddresses) {
        expect(await connectOutcome(address, 7420), address).not.toBe('connected');
      }
    } finally {
      await inspector.close();
    }
    expect(await connectOutcome('127.0.0.1', 7420)).not.toBe('connected');
  });

  it('refuses a request addressed to any other Host, so a foreign page cannot read it through DNS rebinding', async () => {
    const inspector = await startInspector({ port: 0, backend, engine, listRuns: () => readRunRecords(backend.layout.runs) });
    try {
      const port = Number(new URL(inspector.url).port);
      expect(port).toBeGreaterThan(0);
      expect(await statusWithHostHeader(port, `127.0.0.1:${port}`)).toBe(200);
      expect(await statusWithHostHeader(port, `localhost:${port}`)).toBe(200);
      expect(await statusWithHostHeader(port, `attacker.invalid:${port}`)).toBe(403);
      expect(await statusWithHostHeader(port, 'attacker.invalid')).toBe(403);
    } finally {
      await inspector.close();
    }
  });

  it('rejects options without read dependencies', async () => {
    await expect(startInspector({} as never)).rejects.toThrow(TypeError);
  });
});
