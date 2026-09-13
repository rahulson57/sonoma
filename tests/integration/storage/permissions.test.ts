/** SPEC-005 / SPEC-003: the store directory is 0700 and every file under it 0600. */
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, openBackend, walkTree, type TreeEntry } from './support.js';
import path from 'node:path';

function violations(entries: readonly TreeEntry[]): string[] {
  return entries
    .filter((entry) => entry.mode !== (entry.isDirectory ? 0o700 : 0o600))
    .map((entry) => `${entry.rel} ${entry.mode.toString(8)}`);
}

describe('.ckpt permissions', () => {
  it('.ckpt/ has mode 0700 and every file under it has mode 0600', async () => {
    const repo = await tmpGitRepo({ files: { 'a.txt': 'a\n' } });
    const store = path.join(repo.dir, '.ckpt');
    try {
      const { backend } = await openBackend(repo.dir);
      const run = await backend.createRun({ agent: 'claude-code' });
      await backend.appendEvent(run.run_id, { type: 'agent.started', actor: 'runtime', payload: {} });
      await backend.appendEvent(run.run_id, { type: 'tool.completed', actor: 'runtime', payload: { stdout: 'z'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1) } });
      await backend.putBlob(Readable.from([Buffer.from('streamed blob')]));
      const c1 = await checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: null }, { 'a.txt': 'a\n', 'bin/tool': '#!/bin/sh\n' });
      await checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: c1.checkpoint_id }, { 'a.txt': 'b\n' });
      await backend.fork({ run_id: run.run_id, checkpoint_id: c1.checkpoint_id });
      await backend.getState({ run_id: run.run_id, checkpoint_id: c1.checkpoint_id });

      // While the store is open: WAL files and the run lock exist.
      const open = await walkTree(store);
      const names = open.map((entry) => path.basename(entry.rel));
      expect(names).toEqual(expect.arrayContaining(['checkpoint.db', 'checkpoint.db-wal', 'run.json', 'events.jsonl', `${run.run_id}.lock`]));
      expect(open.filter((entry) => !entry.isDirectory && entry.rel.startsWith(path.join('objects', 'sha256'))).length).toBeGreaterThanOrEqual(3);
      expect(open[0]).toEqual({ rel: '.', mode: 0o700, isDirectory: true });
      expect(violations(open)).toEqual([]);

      await backend.close();
      expect(violations(await walkTree(store))).toEqual([]);

      const reopened = await openBackend(repo.dir);
      await reopened.backend.reindex();
      expect(violations(await walkTree(store))).toEqual([]);
      await reopened.backend.close();
      expect(violations(await walkTree(store))).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});
