/**
 * SPEC-012 "Must never mutate checkpoints, runs, refs, blobs, the ledger or the SQLite index. No handler calls a
 * StorageBackend write method or an Engine mutating operation."
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { apiRoutes, buildForkFixture, everyGetPath, missingPaths, openInspector, storeSnapshot } from './support.js';

const STORAGE_WRITES = ['createRun', 'appendEvent', 'putBlob', 'createCheckpoint', 'fork', 'reindex'] as const;
const ENGINE_MUTATIONS = ['startRun', 'record', 'checkpoint', 'resume', 'fork', 'rollback'] as const;
const STORAGE_READS = ['getEvents', 'getCheckpoint', 'listCheckpoints', 'getState'] as const;

type Method = (...args: never[]) => unknown;

function spyAll(target: object, names: readonly string[]): Map<string, ReturnType<typeof vi.fn>> {
  const record = target as Record<string, Method>;
  const spies = new Map<string, ReturnType<typeof vi.fn>>();
  for (const name of names) {
    expect(typeof record[name], name).toBe('function');
    spies.set(name, vi.spyOn(record, name) as unknown as ReturnType<typeof vi.fn>);
  }
  return spies;
}

describe('the inspector never mutates the store', () => {
  it('exercising every endpoint over a fixture run calls StorageBackend write methods and Engine create/resume/fork/rollback 0 times, and the SQLite file, CAS directory and refs/checkpoints/* are byte-identical before and after', async () => {
    const fx = await buildForkFixture();
    try {
      const before = await storeSnapshot(fx.repo.dir);
      expect(Object.keys(before).some((key) => key.startsWith('.ckpt/objects/'))).toBe(true);
      expect(Object.keys(before).some((key) => key.startsWith('.ckpt/runs/'))).toBe(true);
      expect(before['refs/checkpoints/*']?.split('\n').filter(Boolean)).toHaveLength(5);

      const ui = await openInspector(fx.repo.dir);
      const writes = spyAll(ui.backend, [...STORAGE_WRITES, 'getBlob']);
      const mutations = spyAll(ui.engine, ENGINE_MUTATIONS);
      const reads = spyAll(ui.backend, STORAGE_READS);
      const diff = spyAll(ui.engine, ['diff']);
      try {
        for (const pathName of everyGetPath(fx)) {
          expect((await ui.request(pathName)).status, `GET ${pathName}`).toBe(200);
          expect((await ui.request(pathName, { method: 'HEAD' })).status, `HEAD ${pathName}`).toBe(200);
        }
        for (const pathName of missingPaths(fx)) {
          expect((await ui.request(pathName)).status, `GET ${pathName}`).toBe(404);
        }
        for (const route of apiRoutes(fx)) {
          for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect((await ui.request(route, { method, body: '{}' })).status, `${method} ${route}`).toBe(405);
          }
        }
      } finally {
        await ui.close();
      }

      for (const [name, spy] of writes) expect(spy, `StorageBackend.${name}`).toHaveBeenCalledTimes(0);
      for (const [name, spy] of mutations) expect(spy, `CheckpointEngine.${name}`).toHaveBeenCalledTimes(0);
      // Not vacuous: the handlers did read through these very objects.
      for (const [name, spy] of reads) expect(spy.mock.calls.length, `StorageBackend.${name}`).toBeGreaterThan(0);
      expect(diff.get('diff')?.mock.calls.length).toBeGreaterThan(0);

      expect(await storeSnapshot(fx.repo.dir)).toEqual(before);
    } finally {
      await fx.cleanup();
    }
  });
});
