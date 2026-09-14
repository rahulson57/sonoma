/**
 * SPEC-011 "Must never include refs/heads/*, the user's branch, .env*, or anything isExcludedPath()
 * excludes (even with --unsafe)".
 */
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { decodeGitObject } from '../../../src/bundle/git.js';
import { UNSAFE_CONFIRMATION, UNSAFE_EXPORT_EVENT_TYPE, isBundleError } from '../../../src/bundle/index.js';
import { allEvents, answering, checkpoint, git, openStore, readBundle, type Store } from '../../unit/bundle/fixtures.js';

/** Every file name recorded in the bundle's git tree objects. */
function treeNames(entries: Map<string, Buffer>): string[] {
  const names: string[] = [];
  for (const [name, bytes] of entries) {
    if (!name.startsWith('git/objects/')) continue;
    const { type, content } = decodeGitObject(bytes);
    if (type !== 'tree') continue;
    for (let at = 0; at < content.byteLength; ) {
      const space = content.indexOf(0x20, at);
      const nul = content.indexOf(0, space);
      names.push(content.toString('utf8', space + 1, nul));
      at = nul + 21;
    }
  }
  return names;
}

describe('excluded content', () => {
  let store: Store;

  beforeEach(async () => {
    // The user's branch holds a committed .env; the checkpoint was built from a sanitized staging tree.
    store = await openStore({ files: { '.env': 'API_TOKEN=fixture-not-a-secret\n', 'README.md': '# fixture\n', 'src/app.ts': 'export {};\n' } });
  });

  afterEach(async () => {
    await store.cleanup();
  });

  it('no bundle contains refs/heads/* or any .env* path, safe or unsafe', async () => {
    const run = await store.backend.createRun({ agent: 'claude-code' });
    const first = await checkpoint(store, run.run_id, null, { 'README.md': '# fixture\n', 'src/app.ts': 'export {};\n' });
    await checkpoint(store, run.run_id, first.checkpoint_id, { 'README.md': '# fixture v2\n', 'src/app.ts': 'export {};\n' });
    const mainCommit = (await git(store.repo.dir, ['rev-parse', 'refs/heads/main'])).trim();
    const mainTree = (await git(store.repo.dir, ['rev-parse', 'refs/heads/main^{tree}'])).trim();

    const safe = await store.service.exportBundle(run.run_id, {}, answering('y', `${store.outDir}/safe.bundle`));
    const unsafe = await store.service.exportBundle(run.run_id, { unsafe: true }, answering(UNSAFE_CONFIRMATION, `${store.outDir}/unsafe.bundle`));

    for (const result of [safe, unsafe]) {
      expect(result.status).toBe('written');
      const entries = await readBundle(result.bundlePath!);
      const names = [...entries.keys()];
      expect(names.filter((name) => name.startsWith('refs/') && !name.startsWith('refs/checkpoints/'))).toEqual([]);
      expect(names.some((name) => name.split('/').some((segment) => segment.startsWith('.env')))).toBe(false);
      expect(treeNames(entries).filter((name) => name.startsWith('.env'))).toEqual([]);
      expect(entries.has(`git/objects/${mainCommit}`)).toBe(false);
      expect(entries.has(`git/objects/${mainTree}`)).toBe(false);

      const tar = await readFile(result.bundlePath!);
      expect(tar.includes('refs/heads/')).toBe(false);
      expect(tar.includes('.env')).toBe(false);
    }
  });

  it('a checkpoint tree that holds an excluded path is never exported, even with --unsafe', async () => {
    const run = await store.backend.createRun({ agent: 'claude-code' });
    // Local Storage commits whatever staging tree it is given; this one skipped sanitization.
    await checkpoint(store, run.run_id, null, { 'README.md': '# fixture\n', 'config/.env.local': 'NAME=value\n' });

    for (const [options, answer] of [
      [{}, 'y'],
      [{ unsafe: true }, UNSAFE_CONFIRMATION],
    ] as const) {
      const io = answering(answer);
      await expect(store.service.exportBundle(run.run_id, options, io)).rejects.toSatisfy(
        (err) => isBundleError(err, 'ERR_EXCLUDED_PATH') && String((err as Error).message).includes('config/.env.local'),
      );
      expect(io.calls).toBe(0);
    }
    expect(await readdir(store.outDir)).toEqual([]);
    expect((await allEvents(store, run.run_id)).some((e) => e.type === UNSAFE_EXPORT_EVENT_TYPE)).toBe(false);
  });
});
