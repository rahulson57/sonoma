/**
 * Local Read-Only Inspector HTTP server (SPEC-012, `ckpt ui`).
 *
 * - Binds 127.0.0.1:7420 by default.
 * - Only GET and HEAD are accepted. Every other method gets 405 before any routing.
 * - A request whose Host header is not the bound loopback origin is refused with 403, so a page on another origin
 *   cannot read the store through DNS rebinding. (An explicit wildcard host opts out.)
 * - Serves one self-contained page (assets.ts; the CSP allows only its own origin) and four JSON endpoints (views.ts).
 * - node:http is used only to accept requests. The server opens no outbound connection.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { APP_CSS, APP_JS, INDEX_HTML } from './assets.js';
import { DEFAULT_HOST, DEFAULT_PORT, type InspectorHandle, type InspectorOptions } from './types.js';
import { InspectorError, InspectorViews } from './views.js';

const ALLOWED_METHODS = 'GET, HEAD';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly type: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function json(status: number, value: unknown, headers?: Readonly<Record<string, string>>): Reply {
  return { status, body: JSON.stringify(value), type: 'application/json; charset=utf-8', headers };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InspectorError(404, 'malformed path segment');
  }
}

async function route(views: InspectorViews, method: string, rawUrl: string, hostAllowed: boolean): Promise<Reply> {
  if (method !== 'GET' && method !== 'HEAD') {
    return json(405, { error: `${method} is not allowed: the inspector is read-only` }, { Allow: ALLOWED_METHODS });
  }
  if (!hostAllowed) return json(403, { error: 'the inspector only answers requests addressed to its loopback origin' });

  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
  const query = new URLSearchParams(queryAt < 0 ? '' : rawUrl.slice(queryAt + 1));
  switch (pathname) {
    case '/':
    case '/index.html':
      return { status: 200, body: INDEX_HTML, type: 'text/html; charset=utf-8' };
    case '/app.js':
      return { status: 200, body: APP_JS, type: 'text/javascript; charset=utf-8' };
    case '/app.css':
      return { status: 200, body: APP_CSS, type: 'text/css; charset=utf-8' };
    case '/api/runs':
      return json(200, await views.runs());
    case '/api/diff':
      return json(200, await views.diff(query.get('a'), query.get('b')));
    default:
      break;
  }
  const timeline = /^\/api\/runs\/([^/]+)\/checkpoints$/.exec(pathname);
  if (timeline?.[1] !== undefined) return json(200, await views.timeline(decodeSegment(timeline[1])));
  const checkpoint = /^\/api\/checkpoints\/([^/]+)$/.exec(pathname);
  if (checkpoint?.[1] !== undefined) return json(200, await views.checkpoint(decodeSegment(checkpoint[1])));
  return json(404, { error: `no such route: ${pathname}` });
}

function errorReply(err: unknown): Reply {
  if (err instanceof InspectorError) return json(err.status, { error: err.message });
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return json(500, { error: typeof code === 'string' ? `internal error (${code})` : 'internal error' });
}

function send(res: ServerResponse, method: string, reply: Reply): void {
  const body = Buffer.from(reply.body, 'utf8');
  res.writeHead(reply.status, {
    'Content-Type': reply.type,
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    ...reply.headers,
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function hostChecker(host: string, port: number): (header: string | undefined) => boolean {
  if (host === '0.0.0.0' || host === '::') return () => true;
  const allowed = new Set(
    [`${urlHost(host)}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].map((origin) => origin.toLowerCase()),
  );
  return (header) => header !== undefined && allowed.has(header.toLowerCase());
}

function assertOptions(options: InspectorOptions): void {
  const o = options as unknown as Record<string, unknown> | null | undefined;
  const backend = (typeof o === 'object' && o !== null ? o['backend'] : undefined) as Record<string, unknown> | undefined;
  const engine = (typeof o === 'object' && o !== null ? o['engine'] : undefined) as Record<string, unknown> | undefined;
  const ok =
    typeof o === 'object' &&
    o !== null &&
    typeof o['listRuns'] === 'function' &&
    typeof backend === 'object' &&
    backend !== null &&
    ['getEvents', 'getCheckpoint', 'listCheckpoints', 'getState'].every((name) => typeof backend[name] === 'function') &&
    typeof engine === 'object' &&
    engine !== null &&
    typeof engine['diff'] === 'function' &&
    typeof engine['repoRoot'] === 'string';
  if (!ok) throw new TypeError('startInspector needs {backend: StorageBackend reads, engine: {diff, repoRoot}, listRuns}');
}

/** SPEC-012 `startInspector({port = 7420, host = '127.0.0.1'})`: resolves once listening, to `{url, close()}`. */
export async function startInspector(options: InspectorOptions): Promise<InspectorHandle> {
  assertOptions(options);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError(`port must be an integer in 0..65535, got ${String(port)}`);
  if (typeof host !== 'string' || host.trim() === '') throw new TypeError('host must be a non-empty string');

  const views = new InspectorViews(options);
  let hostAllowed: (header: string | undefined) => boolean = () => false;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    route(views, method, req.url ?? '/', hostAllowed(req.headers.host))
      .catch(errorReply)
      .then((reply) => send(res, method, reply))
      .catch(() => res.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = address !== null && typeof address === 'object' ? address.port : port;
  hostAllowed = hostChecker(host, boundPort);

  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost(host)}:${boundPort}/`,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
