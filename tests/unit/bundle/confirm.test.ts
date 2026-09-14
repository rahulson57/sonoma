/**
 * SPEC-011 export flow steps 3–4: only an explicit 'y' writes bundle bytes.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { BUNDLE_FILE_NAME, EXPORT_PROMPT, isBundleError } from '../../../src/bundle/index.js';
import { answering, openStore, readBundle, seedCleanRun, type Store } from './fixtures.js';

describe('export confirmation', () => {
  let store: Store;
  let runId: string;

  beforeAll(async () => {
    store = await openStore();
    ({ runId } = await seedCleanRun(store));
  });

  afterAll(async () => {
    await store.cleanup();
  });

  it("answering anything other than 'y' leaves no bundle file and returns status 'aborted'", async () => {
    for (const answer of ['n', 'N', '', 'Y', 'yes', ' y', 'y ', 'y\n', 'EXPORT UNSAFE']) {
      const io = answering(answer);
      const result = await store.service.exportBundle(runId, {}, io);
      expect(result.status, JSON.stringify(answer)).toBe('aborted');
      expect(result.bundlePath).toBeUndefined();
      expect(result.report.filesScanned).toBeGreaterThan(0);
      expect(io.calls).toBe(1);
      expect(await readdir(store.outDir), JSON.stringify(answer)).toEqual([]);
    }
  });

  it('shows the report and the SPEC-011 prompt before asking', async () => {
    let seen: { prompt: string; unsafe: boolean; filesScanned: number } | undefined;
    await store.service.exportBundle(runId, {}, {
      async confirm(request) {
        seen = { prompt: request.prompt, unsafe: request.unsafe, filesScanned: request.report.filesScanned };
        expect(await readdir(store.outDir)).toEqual([]);
        return 'n';
      },
    });
    expect(seen).toEqual({ prompt: EXPORT_PROMPT, unsafe: false, filesScanned: expect.any(Number) });
  });

  it("answering exactly 'y' writes a 0600 bundle", async () => {
    const result = await store.service.exportBundle(runId, {}, answering('y'));
    expect(result.status).toBe('written');
    expect(result.bundlePath).toBe(path.join(store.outDir, BUNDLE_FILE_NAME));
    expect((await stat(result.bundlePath!)).mode & 0o777).toBe(0o600);
    expect(await readdir(store.outDir)).toEqual([BUNDLE_FILE_NAME]);
    expect([...(await readBundle(result.bundlePath!)).keys()][0]).toBe('manifest.json');
  });

  it('writeBundle refuses without {confirmed: true} and writes nothing', async () => {
    const outPath = path.join(store.outDir, 'unconfirmed.bundle');
    const { manifest } = await store.service.planExport(runId);
    for (const options of [undefined, {}, { confirmed: false }, { confirmed: 'true' }]) {
      await expect(store.service.writeBundle(manifest, { ...(options as object), outPath } as never)).rejects.toSatisfy((err) =>
        isBundleError(err, 'ERR_NOT_CONFIRMED'),
      );
    }
    expect(await readdir(store.outDir)).not.toContain('unconfirmed.bundle');
  });

  it('writeBundle refuses a manifest that planExport did not produce', async () => {
    const { manifest } = await store.service.planExport(runId);
    const forged = { ...manifest };
    await expect(store.service.writeBundle(forged, { confirmed: true, outPath: path.join(store.outDir, 'forged.bundle') })).rejects.toSatisfy((err) =>
      isBundleError(err, 'ERR_UNKNOWN_PLAN'),
    );
    expect(await readdir(store.outDir)).not.toContain('forged.bundle');
  });
});
