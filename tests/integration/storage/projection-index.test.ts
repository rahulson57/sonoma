/**
 * SPEC-015 amendment 4 / SPEC-005 "Durable projection-and-claim index": projections and claims written in one process
 * are listed by checkpoint and by lineage from a fresh process — a separate Node process, so nothing can survive in
 * memory.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
// A child Node process compiles src/ through tsx; allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import type { Checkpoint, SemanticClaim, SemanticProjection } from '../../../src/model/types.js';
import type { LocalBackend, ProjectionQuery } from '../../../src/storage/index.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { checkpointFiles, makeTempDir, openBackend } from './support.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STORAGE_ENTRY = pathToFileURL(path.join(PROJECT_ROOT, 'src', 'storage', 'index.ts')).href;

type Listing = { ok: true; projections: SemanticProjection[]; claims: SemanticClaim[] } | { ok: false; code: string };

async function listAll(backend: LocalBackend, queries: readonly ProjectionQuery[]): Promise<Listing[]> {
  const out: Listing[] = [];
  for (const query of queries) {
    try {
      out.push({ ok: true, projections: await backend.listProjections(query), claims: await backend.listClaims(query) });
    } catch (err) {
      out.push({ ok: false, code: String((err as { code?: unknown }).code ?? err) });
    }
  }
  return out;
}

/** The same listings, computed by a brand-new Node process that opens the store from disk. */
async function listInFreshProcess(scratch: string, repoDir: string, queries: readonly ProjectionQuery[]): Promise<Listing[]> {
  const script = path.join(scratch, 'list-projections.mts');
  await writeFile(
    script,
    [
      `import { LocalBackend } from ${JSON.stringify(STORAGE_ENTRY)};`,
      'const [repoDir, queriesJson] = process.argv.slice(2);',
      'const backend = await LocalBackend.open({ repoDir });',
      'const out = [];',
      'try {',
      '  for (const query of JSON.parse(queriesJson)) {',
      '    try {',
      '      out.push({ ok: true, projections: await backend.listProjections(query), claims: await backend.listClaims(query) });',
      '    } catch (err) {',
      '      out.push({ ok: false, code: String(err?.code ?? err) });',
      '    }',
      '  }',
      '} finally {',
      '  await backend.close();',
      '}',
      'process.stdout.write(JSON.stringify({ pid: process.pid, out }));',
    ].join('\n'),
  );
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', script, repoDir, JSON.stringify(queries)], {
    cwd: PROJECT_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { pid: number; out: Listing[] };
  expect(parsed.pid).not.toBe(process.pid);
  return parsed.out;
}

let createdMs = Date.UTC(2026, 8, 14, 3, 0, 0);

function projectionOf(id: string, checkpoint: Checkpoint, source: 'distilled' | 'declared', values: readonly string[], fromSeq: number): SemanticProjection {
  createdMs += 1000;
  const distilled = source === 'distilled';
  return {
    id,
    checkpointId: checkpoint.checkpoint_id,
    source,
    distiller: distilled ? { provider: 'anthropic', model: 'claude-haiku-4-5', promptVersion: 'distill-v1' } : null,
    input: { stateHash: checkpoint.state_hash, ledgerRange: [fromSeq, checkpoint.ledger_seq], workspaceCommit: checkpoint.workspace_commit },
    claims: values.map((value, i) => ({
      field: i === 0 ? 'goal' : 'next_action',
      value,
      origin: distilled ? 'distilled' : 'agent_declared',
      provenance: { event_ids: [], artifact_refs: [], workspace_paths: [], checkpoint_ids: [checkpoint.checkpoint_id] },
    })),
    usage: distilled ? { inputTokens: 900, outputTokens: 80, costUsd: 0.0013 } : null,
    createdAt: new Date(createdMs).toISOString(),
  };
}

describe('durable projection and claim index', () => {
  it('projections and claims written in one process are listed by checkpoint and by lineage from a fresh process', async () => {
    const repo = await tmpGitRepo({ files: { 'a.txt': 'a\n' } });
    const scratch = await makeTempDir('ckpt-projection-index-');
    try {
      const { backend } = await openBackend(repo.dir);
      let expected: Listing[];
      let queries: ProjectionQuery[];
      try {
        const main = await backend.createRun({ agent: 'claude-code' });
        const m1 = await checkpointFiles(backend, { run_id: main.run_id, parent_checkpoint_id: null }, { 'a.txt': 'one\n' });
        const m2 = await checkpointFiles(backend, { run_id: main.run_id, parent_checkpoint_id: m1.checkpoint_id }, { 'a.txt': 'two\n' });
        const fork = await backend.fork(m1);
        const f1 = await checkpointFiles(backend, { run_id: fork.run_id, parent_checkpoint_id: null }, { 'a.txt': 'fork\n' });
        const grandchild = await backend.fork(f1);
        const g1 = await checkpointFiles(backend, { run_id: grandchild.run_id, parent_checkpoint_id: null }, { 'a.txt': 'grandchild\n' });
        const other = await backend.createRun({ agent: 'sdk' });
        const o1 = await checkpointFiles(backend, { run_id: other.run_id, parent_checkpoint_id: null }, { 'b.txt': 'other\n' });

        const pm1 = projectionOf('proj_m1', m1, 'distilled', ['Build the index', 'List by lineage'], 0);
        const pm2a = projectionOf('proj_m2_declared', m2, 'declared', ['Declared on main c_2'], m1.ledger_seq);
        const pm2b = projectionOf('proj_m2_redistilled', m2, 'distilled', ['Re-distilled main c_2'], m1.ledger_seq);
        const pf1 = projectionOf('proj_f1', f1, 'declared', ['Fork goal', 'Fork next'], 0);
        const pg1 = projectionOf('proj_g1', g1, 'distilled', ['Grandchild goal'], 0);
        const po1 = projectionOf('proj_o1', o1, 'declared', ['Unrelated run'], 0);

        // Insertion order deliberately differs from listing order.
        const refs = new Map<string, Awaited<ReturnType<LocalBackend['putProjection']>>>();
        for (const projection of [pm2b, pg1, pm1, po1, pf1, pm2a]) refs.set(projection.id, await backend.putProjection(projection));

        // CAS holds the canonical projection; storing it again is a no-op; a stored id is never overwritten.
        const blob = JSON.parse((await buffer(await backend.getBlob(refs.get('proj_m1')!))).toString('utf8')) as unknown;
        expect(blob).toEqual(pm1);
        await expect(backend.putProjection(pm1)).resolves.toEqual(refs.get('proj_m1'));
        await expect(backend.putProjection({ ...pm1, claims: [] })).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
        // It must name a stored checkpoint by id, state hash and workspace commit, and be a valid projection.
        await expect(backend.putProjection({ ...pm1, id: 'proj_x1', input: { ...pm1.input, stateHash: 'e'.repeat(64) } })).rejects.toMatchObject({
          code: 'ERR_NOT_FOUND',
        });
        await expect(
          backend.putProjection({ ...pm1, id: 'proj_x2', input: { ...pm1.input, workspaceCommit: m2.workspace_commit } }),
        ).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
        await expect(backend.putProjection({ ...pm1, id: 'proj_x3', distiller: null })).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });

        const ok = (projections: SemanticProjection[]): Listing => ({ ok: true, projections, claims: projections.flatMap((p) => [...p.claims]) });
        // Four runs have a c_1 (main, its fork, the fork's fork, an unrelated run): the checkpoint query returns only
        // the named run's projections.
        expect([m1, f1, g1, o1].map((cp) => cp.checkpoint_id)).toEqual(['c_1', 'c_1', 'c_1', 'c_1']);
        queries = [
          { runId: main.run_id, checkpointId: 'c_2' },
          { runId: main.run_id, checkpointId: 'c_1' },
          { runId: fork.run_id, checkpointId: 'c_1' },
          { runId: grandchild.run_id, checkpointId: 'c_1' },
          { runId: other.run_id, checkpointId: 'c_1' },
          { runId: fork.run_id, checkpointId: 'c_2' },
          { runId: main.run_id, checkpointId: 'c_9' },
          { runId: main.run_id, lineage: true },
          { runId: fork.run_id, lineage: true },
          { runId: grandchild.run_id, lineage: true },
          { runId: other.run_id, lineage: true },
        ];
        expected = [
          ok([pm2a, pm2b]),
          ok([pm1]),
          ok([pf1]),
          ok([pg1]),
          ok([po1]),
          { ok: false, code: 'ERR_NOT_FOUND' },
          { ok: false, code: 'ERR_NOT_FOUND' },
          ok([pm1, pm2a, pm2b]),
          // The fork descends from main c_1 only: main c_2 is a sibling branch, not lineage.
          ok([pm1, pf1]),
          ok([pm1, pf1, pg1]),
          ok([po1]),
        ];
        expect(await listAll(backend, queries)).toEqual(expected);
        // The run is required: a bare checkpoint id cannot name a checkpoint.
        await expect(backend.listProjections({ checkpointId: 'c_1' } as never)).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
        await expect(backend.listClaims({ checkpointId: 'c_1' } as never)).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
        expect((expected[9] as { claims: SemanticClaim[] }).claims.map((claim) => claim.origin)).toEqual([
          'distilled',
          'distilled',
          'agent_declared',
          'agent_declared',
          'distilled',
        ]);
      } finally {
        await backend.close();
      }

      expect(await listInFreshProcess(scratch.dir, repo.dir, queries)).toEqual(expected);

      // Nothing about the projections is copied into checkpoint.db beyond index columns: claim text lives in CAS.
      const db = await readFile(path.join(repo.dir, '.ckpt', 'checkpoint.db'));
      expect(db.includes(Buffer.from('Re-distilled main c_2'))).toBe(false);
    } finally {
      await scratch.cleanup();
      await repo.cleanup();
    }
  });
});
