/** SPEC-005 change detection: size+mtime unchanged ⇒ not re-read; otherwise rehash. */
import { utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import {
  ChangeDetector,
  RACY_WINDOW_NS,
  nodeChangeDetectionFs,
  type ChangeDetectionFs,
  type FileCache,
  type FileCacheEntry,
} from '../../../src/storage/index.js';
import { fixedClock } from '../../helpers/clock.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { makeTempDir, openBackend, sha256 } from '../../integration/storage/support.js';

/** Real filesystem, with every content read recorded. */
function spyFs(): ChangeDetectionFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    stat: (absPath) => nodeChangeDetectionFs.stat(absPath),
    createReadStream: (absPath) => {
      reads.push(absPath);
      return nodeChangeDetectionFs.createReadStream(absPath);
    },
  };
}

function mapCache(): FileCache {
  const entries = new Map<string, FileCacheEntry>();
  return {
    get: (relPath) => entries.get(relPath),
    set: (entry) => void entries.set(entry.path, entry),
    delete: (relPath) => void entries.delete(relPath),
    paths: () => [...entries.keys()],
  };
}

const T2001 = new Date('2001-01-01T00:00:00Z');
const T2002 = new Date('2002-01-01T00:00:00Z');
const T2003 = new Date('2003-01-01T00:00:00Z');
/** Injected detector clock (ns), well after every fixture mtime. */
const clock = fixedClock(Date.UTC(2026, 0, 1));
const nowNs = (): bigint => BigInt(clock.now()) * 1_000_000n;

describe('ChangeDetector', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: root, cleanup } = await makeTempDir('ckpt-changes-'));
    await writeFile(path.join(root, 'a.txt'), 'alpha\n');
    await writeFile(path.join(root, 'b.txt'), 'bravo\n');
    await utimes(path.join(root, 'a.txt'), T2001, T2001);
    await utimes(path.join(root, 'b.txt'), T2001, T2001);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('a file with unchanged size and mtime is not re-read (read spy count 0)', async () => {
    const fs = spyFs();
    const detector = new ChangeDetector({ root, cache: mapCache(), fs, nowNs });

    const first = await detector.detect(['a.txt', 'b.txt']);
    expect(first.files.map((file) => file.status)).toEqual(['added', 'added']);
    expect(fs.reads).toHaveLength(2);

    fs.reads.length = 0;
    const second = await detector.detect(['a.txt', 'b.txt']);
    expect(fs.reads).toHaveLength(0);
    expect(second.rehashed).toBe(0);
    expect(second.files).toEqual([
      { path: 'a.txt', size: 6, sha256: sha256('alpha\n'), status: 'unchanged', reread: false },
      { path: 'b.txt', size: 6, sha256: sha256('bravo\n'), status: 'unchanged', reread: false },
    ]);
  });

  it('a file with changed mtime is rehashed', async () => {
    const fs = spyFs();
    const detector = new ChangeDetector({ root, cache: mapCache(), fs, nowNs });
    await detector.detect(['a.txt', 'b.txt']);

    // Same bytes, new mtime: re-read, found unchanged.
    await utimes(path.join(root, 'a.txt'), T2002, T2002);
    fs.reads.length = 0;
    const touched = await detector.detect(['a.txt', 'b.txt']);
    expect(fs.reads).toEqual([path.join(root, 'a.txt')]);
    expect(touched.files[0]).toMatchObject({ path: 'a.txt', status: 'unchanged', reread: true, sha256: sha256('alpha\n') });

    // Same size, different bytes, new mtime: re-read, found modified.
    await writeFile(path.join(root, 'a.txt'), 'ALPHA\n');
    await utimes(path.join(root, 'a.txt'), T2003, T2003);
    fs.reads.length = 0;
    const modified = await detector.detect(['a.txt', 'b.txt']);
    expect(fs.reads).toEqual([path.join(root, 'a.txt')]);
    expect(modified.files[0]).toMatchObject({ path: 'a.txt', status: 'modified', reread: true, sha256: sha256('ALPHA\n') });
    expect(modified.files[1]).toMatchObject({ path: 'b.txt', status: 'unchanged', reread: false });
  });

  it('a size change is rehashed even when mtime is restored', async () => {
    const fs = spyFs();
    const detector = new ChangeDetector({ root, cache: mapCache(), fs, nowNs });
    await detector.detect(['a.txt']);

    await writeFile(path.join(root, 'a.txt'), 'alpha, longer\n');
    await utimes(path.join(root, 'a.txt'), T2001, T2001);
    fs.reads.length = 0;
    const result = await detector.detect(['a.txt']);
    expect(fs.reads).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ status: 'modified', sha256: sha256('alpha, longer\n') });
  });

  it('does not trust a file hashed within the racy window of its mtime', async () => {
    const fs = spyFs();
    const mtimeNs = BigInt(T2001.getTime()) * 1_000_000n;
    const detector = new ChangeDetector({ root, cache: mapCache(), fs, nowNs: () => mtimeNs + RACY_WINDOW_NS / 2n });
    await detector.detect(['a.txt']);
    fs.reads.length = 0;
    await detector.detect(['a.txt']);
    expect(fs.reads).toHaveLength(1);
  });

  it('reports files that disappeared and drops them from the cache', async () => {
    const cache = mapCache();
    const detector = new ChangeDetector({ root, cache, fs: spyFs(), nowNs });
    await detector.detect(['a.txt', 'b.txt']);
    const result = await detector.detect(['a.txt']);
    expect(result.removed).toEqual(['b.txt']);
    expect(cache.paths()).toEqual(['a.txt']);
  });

  it('rejects paths that escape the root', async () => {
    const detector = new ChangeDetector({ root, cache: mapCache(), nowNs });
    await expect(detector.detect(['../outside.txt'])).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
    await expect(detector.detect([path.join(root, 'a.txt')])).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
  });

  it('the checkpoint.db-backed cache survives reopening the store', async () => {
    const repo = await tmpGitRepo();
    try {
      const opened = await openBackend(repo.dir);
      const run = await opened.backend.createRun({ agent: 'claude-code' });
      await opened.backend.createChangeDetector(run.run_id, root, { fs: spyFs(), nowNs }).detect(['a.txt', 'b.txt']);
      await opened.backend.close();

      const reopened = await openBackend(repo.dir);
      try {
        const fs = spyFs();
        const result = await reopened.backend.createChangeDetector(run.run_id, root, { fs, nowNs }).detect(['a.txt', 'b.txt']);
        expect(fs.reads).toHaveLength(0);
        expect(result.files.map((file) => file.status)).toEqual(['unchanged', 'unchanged']);
      } finally {
        await reopened.backend.close();
      }
    } finally {
      await repo.cleanup();
    }
  });
});
