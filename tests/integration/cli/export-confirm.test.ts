/**
 * SPEC-013 / SPEC-011: `ckpt export` writes nothing without the exact confirmation, over a real store.
 * - Declining (for example answering 'n') exits 3, and no bundle file exists.
 * - `--unsafe` with any text other than `EXPORT UNSAFE` exits 3. No bundle file exists and no `export.unsafe` event is
 *   recorded.
 * - The confirmed cases, run on the same store, do write, so the negative results are not vacuous.
 * Each case runs in its own directory inside the repo, where the bundle would be written.
 */
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { BUNDLE_FILE_MODE, BUNDLE_FILE_NAME, EXPORT_PROMPT, UNSAFE_EXPORT_EVENT_TYPE, UNSAFE_EXPORT_PROMPT } from '../../../src/bundle/index.js';
import { main } from '../../../src/cli/index.js';
import { captureIo } from '../../unit/cli/support.js';
import { cliStore, withBackend, type CliStore } from './support.js';

describe('ckpt export confirmation (SPEC-013)', () => {
  let store: CliStore | undefined;
  const current = (): CliStore => {
    if (store === undefined) throw new Error('the store was not built');
    return store;
  };

  beforeAll(async () => {
    store = await cliStore(async ({ engine, runId, write }) => {
      await write('app.txt', 'v1\n');
      await engine.checkpoint(runId);
    });
  });
  afterAll(async () => {
    await store?.cleanup();
  });

  async function exportFrom(dirName: string, argv: readonly string[], answer: string) {
    const cwd = path.join(current().repo.dir, dirName);
    await mkdir(cwd, { recursive: true });
    const io = captureIo({ cwd, answers: [answer] });
    const code = await main(argv, { io });
    return { code, io, cwd, files: await readdir(cwd) };
  }

  async function unsafeExportEvents() {
    const { repo, runId } = current();
    const events = await withBackend(repo.dir, (backend) => backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER }));
    return events.filter((event) => event.type === UNSAFE_EXPORT_EVENT_TYPE);
  }

  it.each([
    ['n', 'n'],
    ['N', 'N'],
    ['no', 'no'],
    ['end of input', ''],
  ])("answering %s exits 3 and no bundle file exists", async (label, answer) => {
    const result = await exportFrom(`declined-${label.replace(/\W+/g, '-')}`, ['export', current().runId], answer);

    expect(result.code).toBe(3);
    expect(result.io.prompts).toEqual([EXPORT_PROMPT]);
    expect(result.io.out).toContain('Export scan report');
    expect(result.io.err).toContain('Bundle NOT written');
    expect(result.files).toEqual([]);
    await expect(access(path.join(result.cwd, BUNDLE_FILE_NAME))).rejects.toThrow();
  });

  it.each([
    ['lower case', 'export unsafe'],
    ['y', 'y'],
    ['a trailing space', 'EXPORT UNSAFE '],
    ['a doubled space', 'EXPORT  UNSAFE'],
    ['a prefix', 'EXPORT'],
    ['end of input', ''],
  ])('--unsafe answered with %s exits 3, writes no bundle and records no export.unsafe', async (label, answer) => {
    const result = await exportFrom(`unsafe-declined-${label.replace(/\W+/g, '-')}`, ['export', current().runId, '--unsafe'], answer);

    expect(result.code).toBe(3);
    expect(result.io.prompts).toEqual([UNSAFE_EXPORT_PROMPT]);
    expect(result.io.err).toContain('Bundle NOT written');
    expect(result.files).toEqual([]);
    await expect(access(path.join(result.cwd, BUNDLE_FILE_NAME))).rejects.toThrow();
    expect(await unsafeExportEvents()).toEqual([]);
  });

  it("control: answering 'y' for a checkpoint target writes the bundle (mode 0600) and exits 0", async () => {
    const result = await exportFrom('confirmed', ['export', `${current().runId}:c_1`], 'y');

    expect(result.io.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.files).toEqual([BUNDLE_FILE_NAME]);
    expect((await stat(path.join(result.cwd, BUNDLE_FILE_NAME))).mode & 0o777).toBe(BUNDLE_FILE_MODE);
    expect(result.io.out).toContain(`Bundle written: ${path.join(result.cwd, BUNDLE_FILE_NAME)}`);
  });

  it('control: --unsafe answered with exactly EXPORT UNSAFE writes the bundle and records one export.unsafe', async () => {
    const result = await exportFrom('unsafe-confirmed', ['export', current().runId, '--unsafe'], 'EXPORT UNSAFE');

    expect(result.io.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.files).toEqual([BUNDLE_FILE_NAME]);
    expect(await unsafeExportEvents()).toHaveLength(1);
  });
});
