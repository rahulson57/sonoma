/**
 * SPEC-011 `--unsafe`: only the exact text EXPORT UNSAFE bypasses redaction, the manifest says so, and the
 * choice is appended to the ledger.
 *
 * Event name per interim ruling DEC-023 pending the SPEC-011/SPEC-004 amendment: the type is
 * UNSAFE_EXPORT_EVENT_TYPE, never a string literal here.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { UNSAFE_CONFIRMATION, UNSAFE_EXPORT_EVENT_TYPE, UNSAFE_EXPORT_PROMPT, isBundleError } from '../../../src/bundle/index.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { allEvents, answering, event, openStore, readBundle, seedCleanRun, type Store } from './fixtures.js';

describe('unsafe export gate', () => {
  let store: Store;
  let runId: string;
  const github = secretCorpus().find((sample) => sample.kind === 'github')!.value;

  beforeEach(async () => {
    store = await openStore();
    ({ runId } = await seedCleanRun(store));
    await event(store, runId, 'tool.completed', { stdout: `token is ${github}\n`, stderr: '' });
  });

  afterEach(async () => {
    await store.cleanup();
  });

  const unsafeEvents = async (): Promise<number> => (await allEvents(store, runId)).filter((e) => e.type === UNSAFE_EXPORT_EVENT_TYPE).length;

  it('confirmation text other than exactly EXPORT UNSAFE aborts, with no bundle and no ledger record', async () => {
    const before = (await allEvents(store, runId)).length;
    for (const answer of ['y', 'export unsafe', 'EXPORT UNSAFE ', ' EXPORT UNSAFE', 'EXPORT  UNSAFE', 'EXPORT_UNSAFE', '']) {
      const io = answering(answer);
      const result = await store.service.exportBundle(runId, { unsafe: true }, io);
      expect(result.status, JSON.stringify(answer)).toBe('aborted');
      expect(io.calls).toBe(1);
      expect(await readdir(store.outDir), JSON.stringify(answer)).toEqual([]);
    }
    expect((await allEvents(store, runId)).length).toBe(before);
    expect(await unsafeEvents()).toBe(0);
  });

  it('with EXPORT UNSAFE the manifest has unsafe: true, redaction is bypassed, and the ledger gains one unsafe-export event', async () => {
    const before = await allEvents(store, runId);
    let prompt: string | undefined;
    const result = await store.service.exportBundle(runId, { unsafe: true }, {
      async confirm(request) {
        prompt = request.prompt;
        expect(request.unsafe).toBe(true);
        return UNSAFE_CONFIRMATION;
      },
    });
    expect(prompt).toBe(UNSAFE_EXPORT_PROMPT);
    expect(result.status).toBe('written');

    const entries = await readBundle(result.bundlePath!);
    expect(JSON.parse(entries.get('manifest.json')!.toString('utf8'))).toMatchObject({ unsafe: true, runIds: [runId] });
    // Unsafe means unredacted: the raw token is in the ledger entry.
    expect(entries.get(`runs/${runId}/events.jsonl`)!.includes(github)).toBe(true);

    const after = await allEvents(store, runId);
    expect(after).toHaveLength(before.length + 1);
    const recorded = after.at(-1)!;
    expect(recorded.type).toBe(UNSAFE_EXPORT_EVENT_TYPE);
    expect(recorded.actor).toBe('human');
    expect(recorded.payload).toMatchObject({ confirmation: UNSAFE_CONFIRMATION, run_ids: [runId], checkpoint_ids: ['c_1', 'c_2'] });
    expect(await unsafeEvents()).toBe(1);
  });

  it('a safe export never appends the unsafe-export event and redacts the token', async () => {
    const result = await store.service.exportBundle(runId, {}, answering('y'));
    expect(result.status).toBe('written');
    const entries = await readBundle(result.bundlePath!);
    expect(JSON.parse(entries.get('manifest.json')!.toString('utf8')).unsafe).toBe(false);
    expect(entries.get(`runs/${runId}/events.jsonl`)!.includes(github)).toBe(false);
    expect(await unsafeEvents()).toBe(0);
  });

  it('writeBundle of an unsafe plan without the exact confirmation throws before any ledger record or byte', async () => {
    const { manifest } = await store.service.planExport(runId, { unsafe: true });
    const outPath = path.join(store.outDir, 'direct.bundle');
    for (const unsafeConfirmation of [undefined, 'y', 'export unsafe']) {
      await expect(
        store.service.writeBundle(manifest, { confirmed: true, outPath, ...(unsafeConfirmation === undefined ? {} : { unsafeConfirmation }) }),
      ).rejects.toSatisfy((err) => isBundleError(err, 'ERR_UNSAFE_NOT_CONFIRMED'));
    }
    expect(await readdir(store.outDir)).toEqual([]);
    expect(await unsafeEvents()).toBe(0);

    await store.service.writeBundle(manifest, { confirmed: true, outPath, unsafeConfirmation: UNSAFE_CONFIRMATION });
    expect(await readdir(store.outDir)).toEqual(['direct.bundle']);
    expect(await unsafeEvents()).toBe(1);
  });
});
