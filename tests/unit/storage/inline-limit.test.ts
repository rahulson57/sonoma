/** SPEC-005 "must never store a blob larger than 1 MB inline in SQLite". */
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { GENESIS_PREV_HASH } from '../../../src/ledger/hash.js';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import type { LedgerEvent } from '../../../src/model/types.js';
import { IndexDb } from '../../../src/storage/index.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { makeTempDir, openBackend } from '../../integration/storage/support.js';

describe('inline payload limit', () => {
  it('a payload over 1 MB is stored in CAS; no checkpoint.db record carries it inline', async () => {
    const repo = await tmpGitRepo();
    const { backend } = await openBackend(repo.dir);
    try {
      const run = await backend.createRun({ agent: 'claude-code' });
      const big = 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1024);
      const event = await backend.appendEvent(run.run_id, { type: 'tool.completed', actor: 'runtime', payload: { stdout: big } });
      expect(event.payload).toBeNull();
      expect(event.payload_ref).not.toBeNull();
      expect((await backend.getEvents(run.run_id, { fromSeq: 1, toSeq: 1 }))[0]).toEqual(event);

      const db = new Database(path.join(repo.dir, '.ckpt', 'checkpoint.db'), { readonly: true });
      try {
        const row = db.prepare('SELECT MAX(length(record)) AS longest FROM events').get() as { longest: number } | undefined;
        expect(Number(row?.longest)).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES);
      } finally {
        db.close();
      }
    } finally {
      await backend.close();
      await repo.cleanup();
    }
  });

  it('IndexDb refuses an event whose inline payload is over the limit', async () => {
    const tmp = await makeTempDir('ckpt-indexdb-');
    const index = IndexDb.open(path.join(tmp.dir, 'checkpoint.db'));
    try {
      const event: LedgerEvent = {
        event_id: 'evt_oversize',
        run_id: 'run_00000000000000000000000000',
        seq: 1,
        ts: '2026-01-01T00:00:00.000Z',
        type: 'tool.completed',
        actor: 'runtime',
        intent_id: null,
        payload: { stdout: 'y'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1) },
        payload_ref: null,
        prev_hash: GENESIS_PREV_HASH,
        hash: GENESIS_PREV_HASH,
      };
      expect(() => index.insertEvent(event)).toThrow(expect.objectContaining({ code: 'ERR_INLINE_TOO_LARGE' }));
    } finally {
      index.close();
      await tmp.cleanup();
    }
  });
});
