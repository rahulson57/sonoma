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
import type { PendingIntent } from '../../../src/model/types.js';
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

  it('derives pending intent as of the checkpoint cursor (DEC-025): work acknowledged after an older checkpoint is never reported completed, and unacknowledged later requests are in_progress', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n', 'src/app.ts': 'export const v = 1;\n' } });
    try {
      const runId = (await fx.engine.startRun({ agent: 'claude-code' })).run_id;
      const tool = (type: 'tool.requested' | 'tool.completed' | 'tool.failed', id: string, extra: Record<string, string> = {}) => ({
        run_id: runId,
        type,
        actor: type === 'tool.requested' ? ('agent' as const) : ('runtime' as const),
        payload: { tool_call_id: id, ...extra },
      });
      const pairs = (intents: readonly PendingIntent[]): Array<[string | null, string]> =>
        intents.map((intent) => [intent.intent_id, intent.status]);

      await fx.engine.record([
        tool('tool.requested', 'call_read', { tool: 'Read' }),
        tool('tool.completed', 'call_read', { stdout: 'ok\n' }),
        tool('tool.requested', 'call_slow', { tool: 'Bash' }),
        tool('tool.requested', 'call_bad', { tool: 'Bash' }),
        tool('tool.failed', 'call_bad', { error: 'exit 1' }),
      ]);
      const c1 = await fx.engine.checkpoint(runId);

      // After c_1: an edit is requested, applied and acknowledged, and call_slow is only now acknowledged.
      await writeFiles(fx.repo.dir, { 'src/app.ts': 'export const v = 2;\n' });
      await fx.engine.record([
        tool('tool.requested', 'call_edit', { tool: 'Edit' }),
        tool('tool.completed', 'call_edit', { stdout: 'edited\n' }),
        tool('tool.completed', 'call_slow', { stdout: 'done\n' }),
      ]);
      const c2 = await fx.engine.checkpoint(runId);
      expect(c2.workspace_commit).not.toBe(c1.workspace_commit);

      // After c_2: one request is never acknowledged, another fails.
      await fx.engine.record([
        tool('tool.requested', 'call_late', { tool: 'Edit' }),
        tool('tool.requested', 'call_late_bad', { tool: 'Bash' }),
        tool('tool.failed', 'call_late_bad', { error: 'exit 2' }),
      ]);

      // resume(c_1): an older checkpoint. The workspace is c_1's, without the edit.
      const atC1 = await fx.engine.resume({ runId, checkpointId: 'c_1' });
      expect(await readFile(path.join(atC1.worktreePath, 'src', 'app.ts'), 'utf8')).toBe('export const v = 1;\n');
      expect(pairs(atC1.pendingIntent)).toEqual([
        ['call_read', 'completed'],
        ['call_slow', 'in_progress'], // rule 1: acknowledged only after the cursor
        ['call_bad', 'pending'],
        ['call_late', 'in_progress'], // rule 2: after the cursor, never acknowledged through head
      ]);
      // rule 3: call_edit (completed after the cursor) and call_late_bad (failed after it) are not reported at all.
      expect(atC1.pendingIntent.some((intent) => intent.intent_id === 'call_edit')).toBe(false);
      expect(atC1.pendingIntent.find((intent) => intent.intent_id === 'call_slow')).toMatchObject({ resolved_seq: null });
      const late = atC1.pendingIntent.find((intent) => intent.intent_id === 'call_late');
      expect(late).toMatchObject({ kind: 'tool', status: 'in_progress', resolved_seq: null });
      expect(late?.requested_seq).toBeGreaterThan(c2.ledger_seq);
      // Up to the cursor, the report is exactly c_1's own recorded pending_intent.
      expect(atC1.pendingIntent.filter((intent) => intent.requested_seq <= c1.ledger_seq)).toEqual(atC1.state.pending_intent);

      // resume(c_2): the latest checkpoint, same rule.
      const atC2 = await fx.engine.resume({ runId, checkpointId: 'c_2' });
      expect(await readFile(path.join(atC2.worktreePath, 'src', 'app.ts'), 'utf8')).toBe('export const v = 2;\n');
      expect(pairs(atC2.pendingIntent)).toEqual([
        ['call_read', 'completed'],
        ['call_slow', 'completed'],
        ['call_bad', 'pending'],
        ['call_edit', 'completed'],
        ['call_late', 'in_progress'],
      ]);
      expect(atC2.pendingIntent.filter((intent) => intent.requested_seq <= c2.ledger_seq)).toEqual(atC2.state.pending_intent);
    } finally {
      await fx.cleanup();
    }
  });
});
