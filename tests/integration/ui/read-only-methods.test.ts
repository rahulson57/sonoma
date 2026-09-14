/**
 * SPEC-012 "Accept any method other than GET/HEAD (others return 405)".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { UNKNOWN_RUN_ID, apiRoutes, buildForkFixture, openInspector, type ForkFixture, type InspectorFixture } from './support.js';

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('the inspector accepts only GET and HEAD', () => {
  let fx: ForkFixture;
  let ui: InspectorFixture;

  beforeAll(async () => {
    fx = await buildForkFixture();
    ui = await openInspector(fx.repo.dir);
  });

  afterAll(async () => {
    await ui?.close();
    await fx?.cleanup();
  });

  it('POST, PUT, PATCH and DELETE to every /api route return 405', async () => {
    const routes = apiRoutes(fx);
    expect(routes).toHaveLength(4);
    for (const route of routes) {
      for (const method of MUTATING_METHODS) {
        const res = await ui.request(route, { method, headers: { 'content-type': 'application/json' }, body: '{"label":"x"}' });
        expect(res.status, `${method} ${route}`).toBe(405);
        expect(res.headers.get('allow'), `${method} ${route}`).toBe('GET, HEAD');
        expect(res.json, `${method} ${route}`).toEqual({ error: expect.any(String) });
      }
    }
  });

  it('GET and HEAD are accepted on every /api route', async () => {
    for (const route of apiRoutes(fx)) {
      const get = await ui.request(route);
      expect(get.status, `GET ${route}`).toBe(200);
      expect(get.headers.get('content-type')).toBe('application/json; charset=utf-8');
      const head = await ui.request(route, { method: 'HEAD' });
      expect(head.status, `HEAD ${route}`).toBe(200);
      expect(head.text).toBe('');
      expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(get.text)));
    }
  });

  it('other methods are refused before routing: on the page, on unknown ids and on unknown paths too', async () => {
    const paths = ['/', '/app.js', '/api/nope', `/api/runs/${UNKNOWN_RUN_ID}/checkpoints`];
    for (const pathName of paths) {
      for (const method of [...MUTATING_METHODS, 'OPTIONS']) {
        const res = await ui.request(pathName, { method });
        expect(res.status, `${method} ${pathName}`).toBe(405);
      }
    }
  });
});
