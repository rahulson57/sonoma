/**
 * SPEC-011 export flow stages 1–2: planExport enumerates and scans, and writes zero bytes to disk.
 */
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Git-backed store fixtures spawn many git processes.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { classifyEnv } from '../../../src/redact/index.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { event, openStore, seedCleanRun, snapshotTree, type Store } from './fixtures.js';

describe('planExport', () => {
  let store: Store;

  beforeEach(async () => {
    store = await openStore();
  });

  afterEach(async () => {
    await store.cleanup();
  });

  it('writes zero bytes to disk and returns a report whose counts match the fixture', async () => {
    const { runId } = await seedCleanRun(store);
    const artifact = await store.backend.putBlob(Buffer.from('build log: all green\n', 'utf8'));
    await event(store, runId, 'tool.failed', { stderr: 'exit status 1\n', output: artifact });
    await event(store, runId, 'context.built', { env: classifyEnv({ PATH: '/usr/bin', HOME: '/home/dev' }) });
    const github = secretCorpus().find((sample) => sample.kind === 'github')!.value;
    await event(store, runId, 'tool.completed', { stdout: `token is ${github}\n`, stderr: '' });

    const repoBefore = await snapshotTree(store.repo.dir);
    const outBefore = await snapshotTree(store.outDir);

    const { manifest, report } = await store.service.planExport(runId);

    // Nothing under the repository (worktree, .git, .ckpt) or the output directory changed or appeared.
    expect(await snapshotTree(store.repo.dir)).toEqual(repoBefore);
    expect(await snapshotTree(store.outDir)).toEqual(outBefore);
    expect(await readdir(store.outDir)).toEqual([]);

    // Fixture: run.json + events.jsonl + 2 state blobs + 1 artifact blob + 4 distinct workspace blobs
    // (README.md, src/app.ts v1 and v2, docs/notes.md).
    expect(report.filesScanned).toBe(9);
    // tool.requested, tool.completed, tool.failed, tool.completed.
    expect(report.toolOutputs).toBe(4);
    // PATH and HOME, as classifyEnv() entries.
    expect(report.envEntries).toBe(2);
    expect(report.hits.filter((hit) => hit.kind === 'github')).toHaveLength(1);

    expect(manifest).toMatchObject({ schemaVersion: 1, runIds: [runId], checkpointIds: ['c_1', 'c_2'], unsafe: false });
    expect(manifest.blobRefs).toHaveLength(3);
    expect(manifest.blobRefs).toContain(`sha256:${artifact.sha256}`);
    expect(manifest.gitRefs.map((ref) => ref.ref)).toEqual([`refs/checkpoints/${runId}/c_1`, `refs/checkpoints/${runId}/c_2`]);
  });

  it('writes nothing for a checkpoint target with the workspace left out either', async () => {
    const { runId } = await seedCleanRun(store);
    const repoBefore = await snapshotTree(store.repo.dir);

    const { manifest, report } = await store.service.planExport({ run_id: runId, checkpoint_id: 'c_1' }, { includeWorkspace: false });

    expect(await snapshotTree(store.repo.dir)).toEqual(repoBefore);
    expect(await readdir(store.outDir)).toEqual([]);
    expect(manifest.checkpointIds).toEqual(['c_1']);
    expect(manifest.gitRefs).toEqual([]);
    // run.json + events.jsonl (through c_1's cursor) + c_1's state blob.
    expect(report.filesScanned).toBe(3);
    expect(report.toolOutputs).toBe(2);
  });

  it('returns a frozen manifest', async () => {
    const { runId } = await seedCleanRun(store);
    const { manifest } = await store.service.planExport(runId);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(() => {
      (manifest as { unsafe: boolean }).unsafe = true;
    }).toThrow(TypeError);
  });
});
