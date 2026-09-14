/**
 * Real-engine fixtures for the Claude Code Adapter integration tests: a throwaway repository, LocalBackend and
 * CheckpointEngine (tests/integration/engine/support.ts), a run started the way run() starts it, and a hook handler
 * bound to that run through CKPT_RUN_ID.
 */
import { createHookHandler, RUN_ID_ENV, type HookHandler } from '../../../../src/adapters/claude-code/index.js';
import type { Run } from '../../../../src/model/types.js';
import { engineFixture, type EngineFixture } from '../../engine/support.js';

export interface AdapterFixture extends EngineFixture {
  readonly run: Run;
  readonly handler: HookHandler;
}

export async function adapterFixture(files: Record<string, string> = { 'README.md': '# app\n' }): Promise<AdapterFixture> {
  const fx = await engineFixture({ files });
  try {
    const run = await fx.engine.startRun({ agent: 'claude-code' });
    const handler = createHookHandler({ engine: fx.engine, ledger: fx.backend, env: { [RUN_ID_ENV]: run.run_id } });
    return { ...fx, run, handler };
  } catch (err) {
    await fx.cleanup();
    throw err;
  }
}

/** Common hook input fields Claude Code sends with every hook. */
export function hookInput(hook: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d',
    transcript_path: '/home/dev/.claude/projects/app/session.jsonl',
    cwd: '/home/dev/app',
    permission_mode: 'default',
    hook_event_name: hook,
    ...fields,
  };
}
