/**
 * A Claude Code session played through the adapter into the REAL Checkpoint Engine and LocalBackend: the ledger holds
 * the SPEC-009 mapping (with no engine-owned type recorded by the adapter), a Write that changes the workspace yields
 * workspace.changed from real `git status`, tool_use_id correlates requests and acknowledgements through the top-level
 * intent_id, and Stop / SessionEnd each produce one checkpoint whose tree holds the written file.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { allEvents, treePaths, writeFiles } from '../../engine/support.js';
import { adapterFixture, hookInput } from './support.js';

describe('Claude Code session through the real engine', () => {
  it('maps every hook into the ledger, checkpoints at Stop and SessionEnd, and derives pending intent from tool_use_id', async () => {
    const fx = await adapterFixture();
    try {
      const write = 'toolu_01WriteAaBbCcDdEeFfGgHh';
      const read = 'toolu_01ReadAaBbCcDdEeFfGgHhI';
      const bash = 'toolu_01BashAaBbCcDdEeFfGgHhJ';
      const events = () => allEvents(fx.backend, fx.run.run_id);

      const started = await fx.handler.handleHook(JSON.stringify(hookInput('SessionStart', { source: 'startup', model: 'claude-opus-5' })));
      expect(started).toBe((await events())[0]!.event_id);

      await fx.handler.handleHook(hookInput('UserPromptSubmit', { prompt: 'add a dry-run flag' }));
      const writeInput = { file_path: 'scripts/deploy.ts', content: 'export const dryRun = true;\n' };
      await fx.handler.handleHook(hookInput('PreToolUse', { tool_name: 'Write', tool_input: writeInput, tool_use_id: write }));
      await writeFiles(fx.repo.dir, { 'scripts/deploy.ts': writeInput.content });
      await fx.handler.handleHook(hookInput('PostToolUse', { tool_name: 'Write', tool_input: writeInput, tool_response: { success: true }, tool_use_id: write }));
      await fx.handler.handleHook(hookInput('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_use_id: read }));
      await fx.handler.handleHook(hookInput('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_response: '# app\n', tool_use_id: read }));
      await fx.handler.handleHook(hookInput('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: bash }));
      await fx.handler.handleHook(hookInput('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: bash, error: 'exit 1', is_interrupt: false }));
      await fx.handler.handleHook(hookInput('Stop', { stop_hook_active: false, last_assistant_message: 'done' }));
      await fx.handler.handleHook(hookInput('SessionStart', { source: 'resume' }));
      await fx.handler.handleHook(hookInput('SessionEnd', { reason: 'prompt_input_exit' }));

      const ledger = await events();
      expect(ledger.map((event) => event.type)).toEqual([
        'run.created',
        'model.requested',
        'tool.requested',
        'tool.completed',
        'workspace.changed',
        'tool.requested',
        'tool.completed',
        'tool.requested',
        'tool.failed',
        'agent.suspended',
        'checkpoint.created',
        'agent.started',
        'agent.suspended',
        'checkpoint.created',
      ]);
      expect(ledger.filter((event) => event.type === 'adapter.error')).toEqual([]);
      expect(ledger.find((event) => event.type === 'workspace.changed')!.payload).toMatchObject({
        tool: 'Write',
        entries: [{ status: '??', path: 'scripts/' }],
      });

      const checkpoints = await fx.backend.listCheckpoints(fx.run.run_id);
      expect(checkpoints.map((checkpoint) => checkpoint.label)).toEqual([null, null]);
      expect(await treePaths(fx.repo.dir, checkpoints[0]!.workspace_commit)).toContain('scripts/deploy.ts');

      const state = await fx.backend.getState({ run_id: fx.run.run_id, checkpoint_id: checkpoints[0]!.checkpoint_id });
      expect(state.pending_intent.map((intent) => [intent.intent_id, intent.status])).toEqual([
        [write, 'completed'],
        [read, 'completed'],
        [bash, 'pending'],
      ]);
    } finally {
      await fx.cleanup();
    }
  });
});
