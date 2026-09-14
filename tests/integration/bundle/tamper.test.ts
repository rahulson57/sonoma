/**
 * SPEC-011 "Import": a bundle with a tampered blob or a broken hash chain aborts and leaves zero new
 * rows, blobs or refs.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { isBundleError } from '../../../src/bundle/index.js';
import { answering, checkpoint, openStore, readBundle, seedCleanRun, snapshotTree, storeState, tamperedCopy, type Store } from '../../unit/bundle/fixtures.js';

describe('tampered bundle import', () => {
  let source: Store;
  let destination: Store;
  let bundlePath: string;
  let runId: string;
  let stateSha: string;

  beforeAll(async () => {
    source = await openStore();
    ({ runId } = await seedCleanRun(source));
    stateSha = (await source.backend.listCheckpoints(runId))[0]!.state_hash;
    bundlePath = (await source.service.exportBundle(runId, {}, answering('y'))).bundlePath!;

    // The destination already holds a run of its own, so "no new state" is measured against real content.
    destination = await openStore();
    const own = await destination.backend.createRun({ agent: 'sdk' });
    await checkpoint(destination, own.run_id, null, { 'own.txt': 'destination content\n' });
  });

  afterAll(async () => {
    await source.cleanup();
    await destination.cleanup();
  });

  async function expectRejectedWithoutWrites(variant: string, pattern: RegExp): Promise<void> {
    const before = await storeState(destination);
    const runsBefore = await snapshotTree(destination.backend.layout.runs);
    // The destination's own run keeps its writer lock while its backend is open; import must add none.
    const locksBefore = await readdir(destination.backend.layout.lock);
    await expect(destination.service.importBundle(variant)).rejects.toSatisfy((err) => isBundleError(err, 'ERR_TAMPERED') && pattern.test(String((err as Error).message)));
    expect(await storeState(destination)).toEqual(before);
    expect(await snapshotTree(destination.backend.layout.runs)).toEqual(runsBefore);
    expect(await readdir(destination.backend.layout.lock)).toEqual(locksBefore);
    expect(locksBefore).not.toContain(`${runId}.lock`);
    expect(before.runs).not.toContain(runId);
  }

  it('the untampered bundle is importable (control)', async () => {
    const entries = await readBundle(bundlePath);
    expect(entries.has(`objects/sha256/${stateSha.slice(0, 2)}/${stateSha}`)).toBe(true);
  });

  it('one tampered CAS blob aborts with zero new rows, blobs or refs', async () => {
    const variant = path.join(source.outDir, 'tampered-blob.bundle');
    await tamperedCopy(bundlePath, variant, `objects/sha256/${stateSha.slice(0, 2)}/${stateSha}`, (content) => {
      const at = content.indexOf('c_1');
      content.write('c_9', at, 'utf8');
    });
    await expectRejectedWithoutWrites(variant, /does not match its address/);
  });

  it('one tampered git object aborts with zero new rows, blobs or refs', async () => {
    const entries = await readBundle(bundlePath);
    const blobEntry = [...entries].find(([name, bytes]) => name.startsWith('git/objects/') && bytes.toString('latin1').startsWith('blob '))![0];
    const variant = path.join(source.outDir, 'tampered-git.bundle');
    await tamperedCopy(bundlePath, variant, blobEntry, (content) => {
      const at = content.byteLength - 2;
      content.writeUInt8(content.readUInt8(at) ^ 0x01, at);
    });
    await expectRejectedWithoutWrites(variant, /does not match its id/);
  });

  it('a broken ledger hash chain aborts with zero new rows, blobs or refs', async () => {
    const variant = path.join(source.outDir, 'broken-chain.bundle');
    await tamperedCopy(bundlePath, variant, `runs/${runId}/events.jsonl`, (content) => {
      const at = content.indexOf('ls src');
      expect(at).toBeGreaterThan(0);
      content.write('ls srd', at, 'utf8');
    });
    await expectRejectedWithoutWrites(variant, /hash chain of .* is broken at seq 1/);
  });

  it('a redacted bundle whose hashes no longer verify is rejected with a hint to export --unsafe', async () => {
    const variant = path.join(source.outDir, 'redacted-chain.bundle');
    await tamperedCopy(bundlePath, variant, `runs/${runId}/events.jsonl`, (content) => {
      // Same length as the path it replaces, so only the hashed bytes change.
      const at = content.indexOf('docs/notes.md');
      expect(at).toBeGreaterThan(0);
      content.write('[REDACTED:pa]', at, 'utf8');
    });
    await expectRejectedWithoutWrites(variant, /--unsafe/);
  });
});
