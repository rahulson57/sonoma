/**
 * SPEC-011: export then import into a fresh tmpGitRepo() round-trips checkpoint ids, state blobs, ledger
 * hashes and refs/checkpoints/* shas.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
import { answering, allEvents, checkpoint, event, git, openStore, seedCleanRun, snapshotTree, type Store } from '../../unit/bundle/fixtures.js';

async function checkpointRefs(store: Store): Promise<string> {
  return git(store.repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/checkpoints']);
}

async function stateBlobBytes(store: Store, sha: string): Promise<Buffer> {
  return readFile(path.join(store.backend.layout.objects, sha.slice(0, 2), sha));
}

describe('bundle round trip', () => {
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

  it('export then import into a fresh tmpGitRepo() keeps checkpoint ids, state blobs, ledger hashes and refs/checkpoints/* shas identical', async () => {
    const { runId } = await seedCleanRun(source);
    const artifact = await source.backend.putBlob(Buffer.from('coverage: 87 percent\n', 'utf8'));
    await event(source, runId, 'tool.completed', { stdout: 'tests passed', stderr: '', output: artifact });
    // Over the 1 MB inline limit: stored as payload_ref.
    const big = await event(source, runId, 'tool.completed', { stdout: 'lorem ipsum dolor sit amet '.repeat(45_000), stderr: '' });
    expect(big.payload_ref).not.toBeNull();
    await checkpoint(source, runId, 'c_2', { 'README.md': '# demo project\n', 'src/app.ts': 'export const version = 3;\n', 'src/lib/util.ts': 'export {};\n' }, 'third');

    const result = await source.service.exportBundle(runId, {}, answering('y'));
    expect(result.status).toBe('written');
    // Verified identifiers are not redaction hits, so a clean run exports unchanged and stays importable.
    expect(result.report.hits).toEqual([]);

    expect(await destination.service.importBundle(result.bundlePath!)).toEqual({ runIds: [runId] });

    const sourceCheckpoints = await source.backend.listCheckpoints(runId);
    const importedCheckpoints = await destination.backend.listCheckpoints(runId);
    expect(importedCheckpoints.map((c) => c.checkpoint_id)).toEqual(['c_1', 'c_2', 'c_3']);
    expect(importedCheckpoints).toEqual(sourceCheckpoints);

    for (const cp of sourceCheckpoints) {
      const ref = { run_id: runId, checkpoint_id: cp.checkpoint_id };
      expect(await destination.backend.getState(ref)).toEqual(await source.backend.getState(ref));
      expect((await stateBlobBytes(destination, cp.state_hash)).equals(await stateBlobBytes(source, cp.state_hash))).toBe(true);
      expect(await git(destination.repo.dir, ['ls-tree', '-r', cp.workspace_commit])).toBe(await git(source.repo.dir, ['ls-tree', '-r', cp.workspace_commit]));
    }

    const sourceEvents = await allEvents(source, runId);
    const importedEvents = await allEvents(destination, runId);
    expect(importedEvents.map((e) => e.hash)).toEqual(sourceEvents.map((e) => e.hash));
    expect(importedEvents).toEqual(sourceEvents);

    expect(await checkpointRefs(destination)).toBe(await checkpointRefs(source));
    expect((await checkpointRefs(destination)).trim().split('\n')).toHaveLength(3);

    // The user's branch in the destination is untouched.
    expect(await git(destination.repo.dir, ['for-each-ref', 'refs/heads'])).not.toContain('checkpoints');

    // The imported run is a normal run: its ledger continues from the imported head.
    const next = await destination.backend.appendEvent(runId, { type: 'agent.resumed', actor: 'runtime', payload: {} });
    expect(next.seq).toBe(sourceEvents.at(-1)!.seq + 1);
    expect(next.prev_hash).toBe(sourceEvents.at(-1)!.hash);
  });

  it('importing the same bundle twice changes nothing the second time', async () => {
    const { runId } = await seedCleanRun(source);
    const result = await source.service.exportBundle(runId, {}, answering('y'));
    await destination.service.importBundle(result.bundlePath!);
    const before = await snapshotTree(destination.backend.layout.runs);
    const refsBefore = await checkpointRefs(destination);

    expect(await destination.service.importBundle(result.bundlePath!)).toEqual({ runIds: [runId] });
    expect(await snapshotTree(destination.backend.layout.runs)).toEqual(before);
    expect(await checkpointRefs(destination)).toBe(refsBefore);
  });

  it('a checkpoint bundle round-trips that checkpoint and the ledger up to its cursor', async () => {
    const { runId, checkpoints } = await seedCleanRun(source);
    const first = checkpoints[0]!;
    await event(source, runId, 'tool.requested', { tool: 'bash', command: 'npm test' });

    const result = await source.service.exportBundle({ run_id: runId, checkpoint_id: 'c_1' }, {}, answering('y'));
    await destination.service.importBundle(result.bundlePath!);

    expect((await destination.backend.listCheckpoints(runId)).map((c) => c.checkpoint_id)).toEqual(['c_1']);
    const imported = await allEvents(destination, runId);
    expect(imported.at(-1)!.seq).toBe(first.ledger_seq);
    expect(imported.map((e) => e.hash)).toEqual((await allEvents(source, runId)).slice(0, first.ledger_seq).map((e) => e.hash));
    expect((await checkpointRefs(destination)).trim()).toBe(`refs/checkpoints/${runId}/c_1 ${first.workspace_commit}`);
  });
});
