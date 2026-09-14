/**
 * SPEC-005: checkpoint.db is a rebuildable index — reindex() reproduces it from CAS + refs + ledger, including
 * (SPEC-015 amendment 4) the projection and claim listings.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { Checkpoint, LedgerEvent, SemanticClaim, SemanticProjection } from '../../../src/model/types.js';
import type { LocalBackend } from '../../../src/storage/index.js';
import { fakeLedgerEvents } from '../../helpers/ledger.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, git, openBackend } from './support.js';

interface Snapshot {
  checkpoints: Checkpoint[];
  events: LedgerEvent[];
  lineageProjections: SemanticProjection[];
  lineageClaims: SemanticClaim[];
  projectionsByCheckpoint: SemanticProjection[][];
  claimsByCheckpoint: SemanticClaim[][];
}

async function snapshot(backend: LocalBackend, runIds: readonly string[]): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  for (const runId of runIds) {
    const checkpoints = await backend.listCheckpoints(runId);
    out[runId] = {
      checkpoints,
      events: await backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER }),
      lineageProjections: await backend.listProjections({ runId, lineage: true }),
      lineageClaims: await backend.listClaims({ runId, lineage: true }),
      projectionsByCheckpoint: await Promise.all(checkpoints.map((cp) => backend.listProjections({ checkpointId: cp.checkpoint_id, runId }))),
      claimsByCheckpoint: await Promise.all(checkpoints.map((cp) => backend.listClaims({ checkpointId: cp.checkpoint_id, runId }))),
    };
  }
  return out;
}

/** Replay fake agent activity (minus checkpoint.created, which only createCheckpoint may emit). */
async function replay(backend: LocalBackend, runId: string, count: number, seed: number): Promise<void> {
  for (const event of fakeLedgerEvents(count, seed).filter((candidate) => candidate.type !== 'checkpoint.created')) {
    await backend.appendEvent(runId, { type: event.type, actor: event.actor, payload: event.payload });
  }
}

function projectionOf(id: string, checkpoint: Checkpoint, source: 'distilled' | 'declared', values: readonly string[], createdAt: string): SemanticProjection {
  const distilled = source === 'distilled';
  return {
    id,
    checkpointId: checkpoint.checkpoint_id,
    source,
    distiller: distilled ? { provider: 'anthropic', model: 'claude-haiku-4-5', promptVersion: 'distill-v1' } : null,
    input: { stateHash: checkpoint.state_hash, ledgerRange: [0, checkpoint.ledger_seq], workspaceCommit: checkpoint.workspace_commit },
    claims: values.map((value) => ({
      field: 'goal',
      value,
      origin: distilled ? 'distilled' : 'agent_declared',
      provenance: { event_ids: [], artifact_refs: [], workspace_paths: [], checkpoint_ids: [checkpoint.checkpoint_id] },
    })),
    usage: distilled ? { inputTokens: 10, outputTokens: 2, costUsd: 0.0001 } : null,
    createdAt,
  };
}

describe('reindex', () => {
  it('deleting checkpoint.db and calling reindex() reproduces identical listCheckpoints, getEvents, projection and claim listings for 3 runs', async () => {
    const repo = await tmpGitRepo({ files: { 'src/index.ts': 'export {};\n' } });
    try {
      const { backend, clock } = await openBackend(repo.dir);
      const first = await backend.createRun({ agent: 'claude-code' });
      const second = await backend.createRun({ agent: 'sdk' });

      // Small streams: every append is an fsync, and the criterion is about 3 runs, not event volume.
      await replay(backend, first.run_id, 12, 11);
      // Events carrying a top-level intent_id survive the rebuild with their hash chain intact.
      await backend.appendEvent(first.run_id, { type: 'tool.requested', actor: 'agent', intent_id: 'toolu_reindex', payload: { tool: 'Bash' } });
      const f1 = await checkpointFiles(backend, { run_id: first.run_id, parent_checkpoint_id: null }, { 'src/index.ts': 'export const a = 1;\n' });
      clock.tick(5000);
      await replay(backend, first.run_id, 8, 12);
      await backend.appendEvent(first.run_id, {
        type: 'tool.completed',
        actor: 'runtime',
        intent_id: 'toolu_reindex',
        payload: { stdout: 'o'.repeat(MAX_INLINE_PAYLOAD_BYTES + 10) },
      });
      const f2 = await checkpointFiles(
        backend,
        { run_id: first.run_id, parent_checkpoint_id: f1.checkpoint_id, label: 'handoff' },
        { 'src/index.ts': 'export const a = 2;\n' },
      );

      await replay(backend, second.run_id, 10, 21);
      await checkpointFiles(backend, { run_id: second.run_id, parent_checkpoint_id: null }, { 'README.md': 'second\n' });

      const third = await backend.fork({ run_id: first.run_id, checkpoint_id: f1.checkpoint_id });
      expect(third).toMatchObject({ parent_run_id: first.run_id, forked_from_checkpoint: 'c_1', agent: 'claude-code' });
      await replay(backend, third.run_id, 5, 31);
      const t1 = await checkpointFiles(backend, { run_id: third.run_id, parent_checkpoint_id: null }, { 'src/index.ts': 'export const a = 100;\n' });
      // A fork's first commit descends from the checkpoint it was forked from.
      expect((await git(repo.dir, ['rev-parse', `${t1.workspace_commit}^`])).trim()).toBe(f1.workspace_commit);

      await backend.putProjection(projectionOf('proj_f1', f1, 'distilled', ['Add a', 'Keep a exported'], '2026-01-01T00:10:00.000Z'));
      await backend.putProjection(projectionOf('proj_f2', f2, 'declared', ['Hand off a = 2'], '2026-01-01T00:11:00.000Z'));
      await backend.putProjection(projectionOf('proj_t1', t1, 'declared', ['Try a = 100'], '2026-01-01T00:12:00.000Z'));
      // CAS noise reindex must not mistake for projections: a projection of no durable checkpoint, and a JSON blob
      // that merely starts like one.
      await backend.putBlob(Buffer.from(canonicalJSON({ ...projectionOf('proj_orphan', f1, 'declared', ['x'], '2026-01-01T00:13:00.000Z'), input: { stateHash: 'f'.repeat(64), ledgerRange: [0, 1], workspaceCommit: f1.workspace_commit } }), 'utf8'));
      await backend.putBlob(Buffer.from(canonicalJSON({ checkpointId: 'c_1', note: 'not a projection' }), 'utf8'));

      const runIds = [first.run_id, second.run_id, third.run_id];
      const before = await snapshot(backend, runIds);
      const totals = Object.values(before).reduce(
        (sum, run) => ({ checkpoints: sum.checkpoints + run.checkpoints.length, events: sum.events + run.events.length }),
        { checkpoints: 0, events: 0 },
      );
      expect(totals.checkpoints).toBe(4);
      expect(before[first.run_id]!.lineageProjections.map((p) => p.id)).toEqual(['proj_f1', 'proj_f2']);
      expect(before[third.run_id]!.lineageProjections.map((p) => p.id)).toEqual(['proj_f1', 'proj_t1']);
      expect(before[third.run_id]!.lineageClaims.map((c) => c.value)).toEqual(['Add a', 'Keep a exported', 'Try a = 100']);
      expect(before[second.run_id]!.lineageProjections).toEqual([]);
      await backend.close();

      const store = path.join(repo.dir, '.ckpt');
      for (const file of ['checkpoint.db', 'checkpoint.db-wal', 'checkpoint.db-shm']) {
        await rm(path.join(store, file), { force: true });
      }

      const { backend: rebuilt } = await openBackend(repo.dir);
      try {
        expect(await rebuilt.listCheckpoints(first.run_id)).toEqual([]);
        await expect(rebuilt.listProjections({ runId: first.run_id, lineage: true })).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' });
        const counts = { runs: 3, ...totals, projections: 3, claims: 4 };
        expect(await rebuilt.reindex()).toEqual(counts);

        const after = await snapshot(rebuilt, runIds);
        expect(after).toEqual(before);
        for (const runId of runIds) {
          expect(verifyChain(after[runId]!.events)).toEqual({ ok: true });
          for (const checkpoint of after[runId]!.checkpoints) {
            await expect(rebuilt.getState(checkpoint)).resolves.toMatchObject({ run_id: runId, checkpoint_id: checkpoint.checkpoint_id });
          }
        }
        expect(after[first.run_id]!.events.filter((event) => event.intent_id === 'toolu_reindex').map((event) => event.type)).toEqual([
          'tool.requested',
          'tool.completed',
        ]);

        // Reindexing a live index is idempotent, and writing continues from the durable head.
        expect(await rebuilt.reindex()).toEqual(counts);
        expect(await snapshot(rebuilt, runIds)).toEqual(before);
        const next = await rebuilt.appendEvent(second.run_id, { type: 'agent.interrupted', actor: 'runtime', payload: {} });
        expect(next.seq).toBe(before[second.run_id]!.events.length + 1);
      } finally {
        await rebuilt.close();
      }
    } finally {
      await repo.cleanup();
    }
    // Three runs of fake activity plus git checkpoints; the default 5 s is too tight under parallel suites.
  }, 60_000);
});
