/** SPEC-005: putBlob is content-addressed by sha256 and deduplicates identical bytes. */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, LocalBackend } from '../../../src/storage/index.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';
import { makeTempDir, openBackend, sha256 } from '../../integration/storage/support.js';

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else found.push(path.relative(root, abs));
    }
  };
  await walk(root);
  return found.sort();
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('CAS dedup (LocalBackend.putBlob)', () => {
  let repo: TmpGitRepo;
  let backend: LocalBackend;

  beforeEach(async () => {
    repo = await tmpGitRepo();
    ({ backend } = await openBackend(repo.dir));
  });

  afterEach(async () => {
    await backend.close();
    await repo.cleanup();
  });

  it('putBlob on identical bytes twice returns the same BlobRef and exactly one file exists under objects/sha256', async () => {
    const bytes = Buffer.from('identical bytes\n'.repeat(4096));
    const first = await backend.putBlob(bytes);
    const second = await backend.putBlob(Buffer.from(bytes));

    expect(second).toEqual(first);
    expect(first).toEqual({ sha256: sha256(bytes), size: bytes.byteLength });
    const objects = path.join(repo.dir, '.ckpt', 'objects', 'sha256');
    expect(await filesUnder(objects)).toEqual([path.join(first.sha256.slice(0, 2), first.sha256)]);
  });

  it('a Readable with the same bytes dedups against a Uint8Array put', async () => {
    const bytes = Buffer.from('streamed payload '.repeat(10_000));
    const fromBytes = await backend.putBlob(bytes);
    const fromStream = await backend.putBlob(Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]));

    expect(fromStream).toEqual(fromBytes);
    expect(await filesUnder(path.join(repo.dir, '.ckpt', 'objects', 'sha256'))).toHaveLength(1);
    expect(await filesUnder(path.join(repo.dir, '.ckpt', 'tmp'))).toEqual([]);
  });

  it('getBlob streams back exactly the stored bytes', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    const ref = await backend.putBlob(bytes);
    expect(await readAll(await backend.getBlob(ref))).toEqual(bytes);
  });

  it('getBlob of an unknown ref rejects with ERR_NOT_FOUND', async () => {
    await expect(backend.getBlob({ sha256: sha256('never stored'), size: 12 })).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
  });
});

describe('BlobStore integrity', () => {
  it('a damaged blob fails verification on read, and a put of the right bytes repairs it', async () => {
    const tmp = await makeTempDir('ckpt-cas-');
    try {
      const store = new BlobStore(path.join(tmp.dir, 'objects'), tmp.dir);
      const bytes = Buffer.from('original content');
      const ref = await store.put(bytes);

      await writeFile(store.pathFor(ref.sha256), Buffer.from('tampered content'));
      await expect(store.read(ref)).rejects.toMatchObject({ code: 'ERR_CORRUPT' });

      await writeFile(store.pathFor(ref.sha256), Buffer.from('short'));
      expect(await store.has(ref)).toBe(false);
      expect(await store.put(bytes)).toEqual(ref);
      expect(await store.read(ref)).toEqual(bytes);
    } finally {
      await tmp.cleanup();
    }
  });
});
