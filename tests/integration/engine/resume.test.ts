/**
 * SPEC-006 resume(ref): the workspace is checked out from workspace_commit into the run's execution
 * worktree, state is loaded, pending intent is recomputed from ledger acknowledgements, and
 * `agent.resumed` is emitted. Exercised as crash recovery: a second process resumes a run whose first
 * writer died without closing.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { CheckpointEngine } from '../../../src/engine/index.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { allEvents, engineFixture, git, writeFiles } from './support.js';

describe('resume()', () => {
  it('restores the worktree so git status --porcelain is empty against workspace_commit, emits agent.resumed, and reports a tool.requested without tool.completed as in_progress', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n', 'src/app.ts': 'export const v = 1;\n' } });
    let backend2: LocalBackend | undefined;
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      await fx.engine.record([
        { run_id: run.run_id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_1', tool: 'Read', input: { path: 'src/app.ts' } } },
        { run_id: run.run_id, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_1', stdout: 'export const v = 1;\n' } },
      ]);
      const c1 = await fx.engine.checkpoint(run.run_id);

      // The agent keeps going, requests an edit, and is killed before the edit is acknowledged.
      await writeFiles(fx.repo.dir, { 'src/app.ts': 'export const v = 2; // half-written\n', 'scratch.txt': 'tmp\n' });
      await fx.engine.record([
        { run_id: run.run_id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_2', tool: 'Edit', input: { path: 'src/app.ts' } } },
      ]);

      // A new process. The dead writer never closed; its run lock is reclaimed. Nothing of the old engine is reused.
      backend2 = await LocalBackend.open({ repoDir: fx.repo.dir, clock: fx.clock, isProcessAlive: () => false });
      const engine2 = await CheckpointEngine.open({ backend: backend2, repoDir: fx.repo.dir });
      const restored = await engine2.resume({ runId: run.run_id, checkpointId: 'c_1' });

      expect(restored.checkpoint).toEqual(c1);
      expect(restored.state).toMatchObject({ run_id: run.run_id, checkpoint_id: 'c_1', ledger_seq: c1.ledger_seq, workspace_commit: c1.workspace_commit });

      const worktree = restored.worktreePath;
      expect(worktree).toBe(engine2.worktreePath(run.run_id));
      expect(path.resolve(worktree)).not.toBe(path.resolve(fx.repo.dir));
      expect(await git(worktree, ['status', '--porcelain'])).toBe('');
      expect((await git(worktree, ['rev-parse', 'HEAD'])).trim()).toBe(c1.workspace_commit);
      expect(await readFile(path.join(worktree, 'src', 'app.ts'), 'utf8')).toBe('export const v = 1;\n');

      const events = await allEvents(backend2, run.run_id);
      expect(events.at(-1)).toMatchObject({
        type: 'agent.resumed',
        payload: { checkpoint_id: 'c_1', ledger_seq: c1.ledger_seq, workspace_commit: c1.workspace_commit },
      });
      expect(events.filter((event) => event.type === 'agent.resumed')).toHaveLength(1);

      const byId = new Map(restored.pendingIntent.map((intent) => [intent.intent_id, intent]));
      expect(byId.get('call_1')).toMatchObject({ kind: 'tool', status: 'completed' });
      expect(byId.get('call_2')).toMatchObject({ kind: 'tool', status: 'in_progress', resolved_seq: null });
      expect(restored.pendingIntent.filter((intent) => intent.status === 'completed').map((intent) => intent.intent_id)).toEqual(['call_1']);

      // The user's worktree was not written.
      expect(await readFile(path.join(fx.repo.dir, 'src', 'app.ts'), 'utf8')).toBe('export const v = 2; // half-written\n');

      // Work continues in the execution worktree; the next checkpoint builds on the resumed one.
      expect(await engine2.workspaceDir(run.run_id)).toBe(worktree);
      await writeFiles(worktree, { 'src/app.ts': 'export const v = 3;\n' });
      const c2 = await engine2.checkpoint(run.run_id);
      expect(c2).toMatchObject({ checkpoint_id: 'c_2', parent_checkpoint_id: 'c_1' });
      expect(await git(fx.repo.dir, ['show', `${c2.workspace_commit}:src/app.ts`])).toBe('export const v = 3;\n');
      const state2 = await backend2.getState({ run_id: run.run_id, checkpoint_id: 'c_2' });
      expect(state2.pending_intent.find((intent) => intent.intent_id === 'call_2')?.status).toBe('in_progress');
    } finally {
      await backend2?.close();
      await fx.cleanup();
    }
  });
});
