/**
 * SPEC-012 "Must never make any outbound network call (no CDN assets, no telemetry)".
 *
 * 1. Every outbound network API in this worker is stubbed to throw and record the attempt. The test's own HTTP client
 *    is the one exception: its sockets are connected with the original connect, before the stub. Every endpoint is
 *    then exercised; zero attempts may be recorded.
 * 2. The served page and its assets reference no external origin, and the CSP allows only the page's own origin.
 * 3. src/ui/** imports no network client module and makes no request call, so no code path goes unexercised.
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
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { buildForkFixture, everyGetPath, missingPaths, type ForkFixture, type InspectorFixture, openInspector } from './support.js';

const attempts: string[] = [];
const restorers: Array<() => void> = [];
const originalConnect = net.Socket.prototype.connect as unknown as (this: net.Socket, options: net.TcpSocketConnectOpts) => net.Socket;

function block<T extends object, K extends keyof T>(target: T, key: K, label: string): void {
  const original = target[key];
  const blocked = function blockedNetworkCall(): never {
    attempts.push(label);
    throw new Error(`network blocked by ui no-network.test.ts: ${label}`);
  };
  Object.defineProperty(target, key, { value: blocked, configurable: true, writable: true });
  restorers.push(() => Object.defineProperty(target, key, { value: original, configurable: true, writable: true }));
}

/** The test's client: its sockets connect with the ORIGINAL connect, so only other connections hit the stub. */
const clientAgent = new http.Agent({ keepAlive: false });
(clientAgent as unknown as { createConnection: (options: { port?: number | string }) => net.Socket }).createConnection = (options) => {
  const socket = new net.Socket();
  originalConnect.call(socket, { host: '127.0.0.1', port: Number(options.port) });
  return socket;
};

interface ClientResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

let fx: ForkFixture;
let ui: InspectorFixture;
let port: number;

function get(pathName: string): Promise<ClientResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET', agent: clientAgent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  fx = await buildForkFixture();
  ui = await openInspector(fx.repo.dir);
  port = Number(new URL(ui.inspector.url).port);

  block(net.Socket.prototype, 'connect', 'net.Socket.connect');
  block(tls, 'connect', 'tls.connect');
  block(dgram.Socket.prototype, 'send', 'dgram.Socket.send');
  block(dgram.Socket.prototype, 'connect', 'dgram.Socket.connect');
  block(dns, 'lookup', 'dns.lookup');
  block(dns, 'resolve', 'dns.resolve');
  block(dns.promises, 'lookup', 'dns.promises.lookup');
  block(dns.promises, 'resolve', 'dns.promises.resolve');
  block(https, 'request', 'https.request');
  block(https, 'get', 'https.get');
  block(globalThis, 'fetch', 'fetch');
});

afterAll(async () => {
  for (const restore of restorers.splice(0).reverse()) restore();
  await ui?.close();
  await fx?.cleanup();
});

describe('the inspector with outbound network access stubbed to throw', () => {
  it('the stub is effective, and the test client still reaches the inspector', async () => {
    expect(() => net.connect(9, '127.0.0.1')).toThrow(/network blocked/);
    await expect(Promise.resolve().then(() => fetch('/'))).rejects.toThrow(/network blocked/);
    expect(() => tls.connect({ host: '127.0.0.1', port: 9 })).toThrow(/network blocked/);
    attempts.length = 0;
    expect((await get('/api/runs')).status).toBe(200);
    expect(attempts).toEqual([]);
  });

  it('exercising every endpoint makes 0 outbound connections', async () => {
    for (const pathName of everyGetPath(fx)) expect((await get(pathName)).status, pathName).toBe(200);
    for (const pathName of missingPaths(fx)) expect((await get(pathName)).status, pathName).toBe(404);
    expect(attempts).toEqual([]);
  });

  it('the served HTML references no external origin (no http(s):// asset URLs)', async () => {
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:|\*/);

    const references = [...page.body.matchAll(/\b(?:src|href|action)\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1] ?? '');
    expect(references.sort()).toEqual(['/app.css', '/app.js']);
    for (const pathName of ['/', ...references]) {
      const res = await get(pathName);
      expect(res.status, pathName).toBe(200);
      expect(res.body, pathName).not.toMatch(/https?:\/\//i);
      expect(res.body, pathName).not.toMatch(/\b(?:src|href)\s*=\s*["']\/\//i);
      expect(res.body, pathName).not.toMatch(/url\(|@import/i);
    }
    expect(attempts).toEqual([]);
  });
});

describe('src/ui/** source', () => {
  it('imports no network client module and makes no request call', async () => {
    const root = fileURLToPath(new URL('../../../src/ui/', import.meta.url));
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.name.endsWith('.ts')) files.push(abs);
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThanOrEqual(5);

    const clientModule = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:net|tls|https|http2|dgram|dns|dns\/promises|undici)['"]/;
    const offenders: string[] = [];
    const httpUsers: string[] = [];
    for (const file of files) {
      const rel = path.relative(root, file);
      const source = await readFile(file, 'utf8');
      if (clientModule.test(source)) offenders.push(`${rel}: network client module`);
      if (/\b(?:http|https)\.(?:request|get)\s*\(|\.connect\s*\(|\bWebSocket\b|\bEventSource\b/.test(source)) offenders.push(`${rel}: outbound call`);
      // The browser page talks only to its own origin (relative /api paths, CSP connect-src 'self').
      if (rel !== 'assets.ts' && /\bfetch\s*\(/.test(source)) offenders.push(`${rel}: fetch`);
      if (/['"]node:http['"]/.test(source)) httpUsers.push(rel);
    }
    expect(offenders).toEqual([]);
    // node:http is used by the server only, to accept requests.
    expect(httpUsers).toEqual(['server.ts']);
  });
});
