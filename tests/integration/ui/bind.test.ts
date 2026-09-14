/**
 * SPEC-012 "Bind to any address other than 127.0.0.1 by default" is never allowed: startInspector() with defaults
 * listens on 127.0.0.1:7420 and on no other address.
 *
 * This file never binds the real port 7420. `npm test` runs in every later gate, often several at once on one
 * machine, and after S12 `ckpt ui` itself holds 7420. A fixed-port bind here would fail with EADDRINUSE, and a
 * post-close probe of a shared port would race other processes. So the defaults test records the address
 * startInspector() asks net.Server#listen for (it must be 127.0.0.1:7420) and forwards the real bind to an ephemeral
 * port on the same host. It then checks the socket the OS actually bound: loopback only, answering, and no longer
 * listening after close().
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

interface ListenRequest {
  readonly server: net.Server;
  readonly port: unknown;
  readonly host: unknown;
}

/**
 * While `body` runs, every net.Server#listen call is recorded with the port/host it asked for, and the bind itself is
 * forwarded with port 0, so the OS picks a free port on the requested host. Handles both the options-object and the
 * positional `(port, host, ...)` forms.
 */
async function withEphemeralListen<T>(body: (requests: readonly ListenRequest[]) => Promise<T>): Promise<T> {
  const requests: ListenRequest[] = [];
  const realListen = net.Server.prototype.listen;
  const spy = vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, ...args: unknown[]) {
    const [first, ...rest] = args;
    if (typeof first === 'object' && first !== null) {
      const options = first as { port?: unknown; host?: unknown };
      requests.push({ server: this, port: options.port, host: options.host });
      return realListen.apply(this, [{ ...options, port: 0 }, ...rest] as never);
    }
    if (typeof first === 'number' || typeof first === 'string') {
      requests.push({ server: this, port: first, host: typeof rest[0] === 'string' ? rest[0] : undefined });
      return realListen.apply(this, [0, ...rest] as never);
    }
    requests.push({ server: this, port: undefined, host: undefined });
    return realListen.apply(this, args as never);
  } as never);
  try {
    return await body(requests);
  } finally {
    spy.mockRestore();
  }
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

    await withEphemeralListen(async (requests) => {
      const inspector = await startInspector({ backend, engine, listRuns: () => readRunRecords(backend.layout.runs) });
      const httpListens = requests.filter((request) => request.server instanceof http.Server);
      expect(httpListens).toHaveLength(1);
      const [request] = httpListens;
      if (request === undefined) throw new Error('unreachable: startInspector did not call listen');
      const { server } = request;
      try {
        // What the defaults ask for: exactly 127.0.0.1:7420.
        expect({ port: request.port, host: request.host }).toEqual({ port: 7420, host: '127.0.0.1' });

        // What the OS bound: an IPv4 loopback socket, not a wildcard.
        const bound = server.address();
        if (bound === null || typeof bound !== 'object') throw new Error(`expected a TCP address, got ${String(bound)}`);
        expect(bound).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
        expect(bound.port).toBeGreaterThan(0);
        expect(inspector.url).toBe(`http://127.0.0.1:${bound.port}/`);

        expect(await connectOutcome('127.0.0.1', bound.port)).toBe('connected');
        const res = await fetch(new URL('api/runs', inspector.url));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);

        // A wildcard (0.0.0.0) listener would also accept on every other local address; this one accepts on none.
        const otherAddresses = Object.values(os.networkInterfaces())
          .flatMap((list) => list ?? [])
          .filter((iface) => iface.family === 'IPv4' && iface.address !== '127.0.0.1')
          .map((iface) => iface.address);
        for (const address of otherAddresses) {
          expect(await connectOutcome(address, bound.port), address).not.toBe('connected');
        }
      } finally {
        await inspector.close();
      }
      // Checked on this server's own socket, not by probing a port another process may have taken since.
      expect(server.listening).toBe(false);
    });
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
