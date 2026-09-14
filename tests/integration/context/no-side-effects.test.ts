/**
 * SPEC-008 "Must never": call an LLM or the Distiller, or write to storage, the ledger or git.
 *
 * Built over the real stack: a throwaway git repository (tests/helpers/tmpRepo.ts), LocalBackend, CheckpointEngine
 * with a distill port wired to a spied provider, a BlobProjectionStore read through projectionStoreClaims, and
 * WorkspaceGit for the Tier 2 diff. Every StorageBackend write method and every mutating engine method is spied, and
 * the ledgers, checkpoint lists, refs and every file of the repository and store are compared before and after.
 *
 * The claim source is exercised through the DEC-036(1) lineage walk: c_2 has no projection of its own (a projection
 * stored under the same checkpoint id with other inputs is not c_2's), so its context uses c_1's; and a run forked
 * from c_2 reaches c_1 across the fork.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { IN_PROGRESS_NOTICE, createContextBuilder, projectionStoreClaims } from '../../../src/context/index.js';
import { BlobProjectionStore } from '../../../src/distill/index.js';
import { CheckpointEngine, WorkspaceGit } from '../../../src/engine/index.js';
import type { Checkpoint, SemanticProjection } from '../../../src/model/types.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { fixedClock } from '../../helpers/clock.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';

const execFileAsync = promisify(execFile);

const STORAGE_WRITE_METHODS = ['createRun', 'appendEvent', 'putBlob', 'createCheckpoint', 'fork', 'reindex'] as const;
const ENGINE_MUTATING_METHODS = ['startRun', 'record', 'checkpoint', 'resume', 'fork', 'rollback'] as const;

type AnyMethods = Record<string, (...args: unknown[]) => unknown>;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
  return stdout;
}

/** rel path → sha256 of the bytes, for every regular file under `root`. SQLite's shared-memory index is skipped: readers update it. */
async function fileDigests(root: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && !entry.name.endsWith('-shm')) digests[path.relative(root, abs)] = createHash('sha256').update(await readFile(abs)).digest('hex');
    }
  };
  await walk(root);
  return digests;
}

async function durableSnapshot(backend: LocalBackend, repoDir: string, runIds: readonly string[]): Promise<unknown> {
  const runs: Record<string, unknown> = {};
  for (const runId of runIds) {
    const events = await backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER });
    runs[runId] = { ledgerLength: events.length, ledgerHead: events.at(-1)?.hash, checkpoints: await backend.listCheckpoints(runId) };
  }
  return {
    runs,
    refs: await git(repoDir, ['for-each-ref', '--format=%(refname) %(objectname)']),
    files: await fileDigests(repoDir),
  };
}

function projectionFor(checkpoint: Checkpoint, id: string, overrides: { stateHash?: string; claimValue: string; eventId: string }): SemanticProjection {
  return {
    id,
    checkpointId: checkpoint.checkpoint_id,
    distiller: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', promptVersion: 'distill-v1' },
    input: { stateHash: overrides.stateHash ?? checkpoint.state_hash, ledgerRange: [0, checkpoint.ledger_seq], workspaceCommit: checkpoint.workspace_commit },
    claims: [
      {
        field: 'goal',
        value: overrides.claimValue,
        origin: 'distilled',
        provenance: { event_ids: [overrides.eventId], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] },
      },
    ],
    usage: { inputTokens: 900, outputTokens: 80, costUsd: 0.0013 },
    createdAt: '2026-09-13T09:30:00.000Z',
  };
}

describe('context build has no side effects', () => {
  it('makes zero storage writes, zero engine mutations and zero LLM/Distiller calls while building resume, handoff and forked-run contexts', async () => {
    const repo = await tmpGitRepo({ files: { 'README.md': '# app\n', 'src/app.ts': 'export const v = 1;\n' } });
    const clock = fixedClock(Date.UTC(2026, 8, 13, 9, 0, 0));
    const backend = await LocalBackend.open({ repoDir: repo.dir, clock });
    try {
      const complete = vi.fn(async (_prompt: string) => ({ text: '{"claims":[]}', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
      const provider = { name: 'anthropic', model: 'claude-haiku-4-5-20251001', complete };
      const distillRequest = vi.fn(async () => {
        await provider.complete('distill');
      });
      const engine = await CheckpointEngine.open({ backend, repoDir: repo.dir, distill: { request: distillRequest } });

      // A run with history on both sides of the checkpoint the context is built from.
      const run = await engine.startRun({ agent: 'claude-code' });
      const runId = run.run_id;
      const first = await engine.record([
        { run_id: runId, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_1', tool: 'Read', input: { path: 'src/app.ts' } } },
        { run_id: runId, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_1', stdout: 'export const v = 1;\n' } },
      ]);
      const cited = first[1];
      if (cited === undefined) throw new Error('record() returned too few events');
      clock.tick(1000);
      const c1 = await engine.checkpoint(runId);

      await writeFile(path.join(repo.dir, 'src', 'app.ts'), 'export const v = 2;\n');
      await writeFile(path.join(repo.dir, 'src', 'util.ts'), 'export const twice = (n: number) => n * 2;\n');
      await engine.record([
        { run_id: runId, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_2', tool: 'Edit', input: { path: 'src/app.ts' } } },
        { run_id: runId, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_2', stdout: 'edited' } },
        { run_id: runId, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_3', tool: 'Bash', input: { command: 'npm test' } } },
        { run_id: runId, type: 'tool.failed', actor: 'runtime', payload: { tool_call_id: 'call_3', error: 'exit 1' } },
        { run_id: runId, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_4', tool: 'Write', input: { path: 'src/util.ts' } } },
      ]);
      clock.tick(1000);
      const c2 = await engine.checkpoint(runId);

      const store = new BlobProjectionStore(backend);
      await store.put(projectionFor(c1, 'proj_c1', { claimValue: 'Bump v to 2', eventId: cited.event_id }));
      // Stored under c_2's id with other inputs (as another run's c_2 would be): not c_2's, so the walk goes on to c_1.
      await store.put(projectionFor(c2, 'proj_other_run', { stateHash: c1.state_hash, claimValue: 'Belongs to another run', eventId: cited.event_id }));

      // A run forked from c_2, whose first checkpoint adds a file.
      const forked = await engine.fork({ runId, checkpointId: c2.checkpoint_id });
      await writeFile(path.join(engine.worktreePath(forked.run_id), 'src', 'forked.ts'), 'export const forked = true;\n');
      clock.tick(1000);
      const f1 = await engine.checkpoint(forked.run_id);

      const restored = await engine.resume({ runId, checkpointId: c2.checkpoint_id });
      await engine.record([
        { run_id: runId, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_5', tool: 'Read', input: { path: 'README.md' } } },
      ]);
      const restoredFork = await engine.resume({ runId: forked.run_id, checkpointId: f1.checkpoint_id });

      const runIds = [runId, forked.run_id];
      const before = await durableSnapshot(backend, repo.dir, runIds);
      const storageWrites = STORAGE_WRITE_METHODS.map((name) => vi.spyOn(backend as unknown as AnyMethods, name));
      const engineMutations = ENGINE_MUTATING_METHODS.map((name) => vi.spyOn(engine as unknown as AnyMethods, name));
      const getEvents = vi.spyOn(backend, 'getEvents');

      const builder = createContextBuilder({ storage: backend, git: await WorkspaceGit.open(repo.dir), claims: projectionStoreClaims(store) });
      const resumeContext = await builder.buildResumeContext(restored);
      const tightContext = await builder.buildResumeContext(restored, { maxTokens: 2000 });
      const handoffContext = await builder.buildHandoffContext(restored, { harness: 'codex', model: 'gpt-5' });
      const forkContext = await builder.buildResumeContext(restoredFork);

      for (const spy of [...storageWrites, ...engineMutations]) expect(spy).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(distillRequest).not.toHaveBeenCalled();
      expect(getEvents).toHaveBeenCalled();
      const cursorOf: Record<string, number> = { [runId]: c2.ledger_seq, [forked.run_id]: f1.ledger_seq };
      for (const [readRunId, range] of getEvents.mock.calls) expect(range.toSeq).toBeLessThanOrEqual(cursorOf[readRunId] ?? -1);
      vi.restoreAllMocks();

      expect(await durableSnapshot(backend, repo.dir, runIds)).toEqual(before);

      for (const [context, budget] of [
        [resumeContext, 8000],
        [tightContext, 2000],
        [handoffContext, 8000],
      ] as const) {
        // DEC-034(3): state.pending_intent is the rendered engine list; nothing is dropped on a run this short.
        expect(context.state).toEqual({ ...restored.state, pending_intent: restored.pendingIntent });
        expect(context.workspaceCommit).toBe(c2.workspace_commit);
        expect(context.tokenEstimate).toBeLessThanOrEqual(budget);
        expect(context.hydratedEvents.every((event) => event.run_id === runId && event.seq <= c2.ledger_seq)).toBe(true);
        expect(context.hydratedEvents[0]?.event_id).toBe(cited.event_id);
      }

      const preamble = resumeContext.systemPreamble;
      expect(preamble).toContain(`semantic state source: checkpoint ${runId}:c_1 (ledger cursor seq ${c1.ledger_seq}), the nearest earlier checkpoint`);
      expect(preamble).toContain('goal:\n  - Bump v to 2');
      expect(preamble).not.toContain('Belongs to another run');
      expect(preamble).toContain(`changed paths since parent c_1 (${c1.workspace_commit}):\n  - M src/app.ts\n  - A src/util.ts`);
      expect(preamble.split('\n').find((line) => line.includes(' call_4,'))).toContain(IN_PROGRESS_NOTICE);
      expect(preamble).toContain(`workspace path: ${restored.worktreePath}`);
      expect(handoffContext.systemPreamble).toContain('target harness: codex');

      // Across the fork: claims from c_1 of the source run, Tier 2 from the fork source c_2.
      const forkPreamble = forkContext.systemPreamble;
      expect(forkContext.workspaceCommit).toBe(f1.workspace_commit);
      expect(forkContext.state).toEqual({ ...restoredFork.state, pending_intent: restoredFork.pendingIntent });
      expect(forkPreamble).toContain(`semantic state source: checkpoint ${runId}:c_1`);
      expect(forkPreamble).toContain(`That checkpoint is in run ${runId}, which this run descends from by fork`);
      expect(forkPreamble).toContain('goal:\n  - Bump v to 2');
      expect(forkPreamble).toContain(`changed paths since fork source ${runId}:c_2 (${c2.workspace_commit}):\n  - A src/forked.ts`);
      expect(forkContext.hydratedEvents.every((event) => event.run_id === forked.run_id && event.seq <= f1.ledger_seq)).toBe(true);
      expect(forkContext.tokenEstimate).toBeLessThanOrEqual(8000);
    } finally {
      vi.restoreAllMocks();
      await backend.close();
      await repo.cleanup();
    }
  });
});
