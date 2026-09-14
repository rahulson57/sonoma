/**
 * SPEC-011 "Must never overwrite an existing run": importing a bundle whose run id exists with a
 * different head is rejected, and the existing run is unchanged.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
import { isBundleError } from '../../../src/bundle/index.js';
import { allEvents, answering, checkpoint, event, git, openStore, seedCleanRun, snapshotTree, storeState, type Store } from '../../unit/bundle/fixtures.js';

describe('import never overwrites a run', () => {
  let source: Store;
  let destination: Store;

  beforeEach(async () => {
    source = await openStore();
    destination = await openStore();
  });

  afterEach(async () => {
    await source.cleanup();
    await destination.cleanup();
  });

  async function runSnapshot(store: Store, runId: string) {
    return {
      files: await snapshotTree(path.join(store.backend.layout.runs, runId)),
      events: await allEvents(store, runId),
      checkpoints: await store.backend.listCheckpoints(runId),
      refs: await git(store.repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/checkpoints/${runId}/`]),
      state: await storeState(store),
    };
  }

  it('a bundle whose run id exists with a different head is rejected and the existing run is unchanged', async () => {
    const { runId } = await seedCleanRun(source);
    const first = await source.service.exportBundle(runId, {}, answering('y', path.join(source.outDir, 'first.bundle')));
    await destination.service.importBundle(first.bundlePath!);

    // The source run moves on: its head is now different from the destination's copy.
    await event(source, runId, 'tool.requested', { tool: 'bash', command: 'npm run build' });
    await checkpoint(source, runId, 'c_2', { 'README.md': '# demo project\n', 'src/app.ts': 'export const version = 4;\n' });
    const second = await source.service.exportBundle(runId, {}, answering('y', path.join(source.outDir, 'second.bundle')));

    const before = await runSnapshot(destination, runId);
    await expect(destination.service.importBundle(second.bundlePath!)).rejects.toSatisfy((err) => isBundleError(err, 'ERR_RUN_EXISTS'));
    expect(await runSnapshot(destination, runId)).toEqual(before);
    expect(before.checkpoints.map((c) => c.checkpoint_id)).toEqual(['c_1', 'c_2']);
  });

  it('a diverged run with the same id and a different head in the destination is rejected too', async () => {
    const { runId } = await seedCleanRun(source);
    const bundle = await source.service.exportBundle(runId, {}, answering('y'));
    await destination.service.importBundle(bundle.bundlePath!);
    // The destination's copy moves on independently.
    await event(destination, runId, 'agent.resumed', { note: 'continued here' });

    const before = await runSnapshot(destination, runId);
    await expect(destination.service.importBundle(bundle.bundlePath!)).rejects.toSatisfy((err) => isBundleError(err, 'ERR_RUN_EXISTS'));
    expect(await runSnapshot(destination, runId)).toEqual(before);
  });
});
