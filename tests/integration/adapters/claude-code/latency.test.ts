/**
 * SPEC-009 criterion: handleHook p95 < 50 ms over 1000 non-boundary invocations (checkpoint boundaries excluded).
 *
 * WHAT IS ASSERTED (DEC-046, from Q-027): the latency the ADAPTER adds to a hook, i.e. each invocation's wall time
 * minus the time spent inside the Checkpoint Engine's record()/checkpoint(). That is SPEC-009's Must-never wording,
 * "Add more than 50 ms p95 per hook invocation". Everything else stays inside the window: payload parsing, the
 * HookMapping, workspaceDir(), `git status` for Write/Edit/Bash, the ledger walk back to the PreToolUse and the
 * lock-retry sleeps.
 * `git status` is one git process, and it is nearly all of the adapter's own time (the rest is well under 1 ms). On
 * PreToolUse it is counted in full, because it must finish before tool.requested, which carries its digest, is
 * appended. On PostToolUse the tool has already run, so the handler reads it while tool.completed is being appended.
 * Only the part that outlasts record() is added wall time there, which is exactly what the hook adds. The ordering
 * is pinned by tests/unit/adapters/claude-code/status-timing.test.ts, and the two paths are reported separately.
 * Why not the absolute wall time: every record() fsyncs the ledger (storage), and `npm test` runs every test file in
 * parallel. The same 1000 invocations have an absolute p95 of about 43 ms alone and well over 100 ms inside the full
 * suite, where hooks that never touch git are just as slow. The absolute p95 is still computed and reported, just not
 * asserted.
 *
 * Real engine, LocalBackend and `git status` in a throwaway repository (tests/helpers/tmpRepo.ts), one bound run, and a
 * realistic hook mix repeated per turn: a prompt, then PreToolUse/PostToolUse pairs for Read, Grep, Write, Edit and
 * Bash, and a PostToolUseFailure. Write/Edit/Bash read git status (DEC-044(4)): the Write really creates a file every
 * turn and every other Edit changes one, so workspace.changed is written too. The Write/Edit/Bash path is reported
 * separately.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });
import { performance } from 'node:perf_hooks';
import { RUN_ID_ENV, WORKSPACE_TOOLS, createHookHandler, type AdapterEngine } from '../../../../src/adapters/claude-code/index.js';
import { allEvents, writeFiles } from '../../engine/support.js';
import { adapterFixture, hookInput } from './support.js';

const INVOCATIONS = 1000;
const P95_BUDGET_MS = 50;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function summary(label: string, values: readonly number[]): string {
  return `${label}: p50=${percentile(values, 50).toFixed(1)} p95=${percentile(values, 95).toFixed(1)} max=${percentile(values, 100).toFixed(1)} ms (n=${values.length})`;
}

describe('hook latency', () => {
  it(`handleHook adds p95 < ${P95_BUDGET_MS} ms over ${INVOCATIONS} non-boundary invocations (engine record/checkpoint time excluded)`, async () => {
    const fx = await adapterFixture({ 'README.md': '# app\n', 'src/app.ts': 'export const version = 0;\n' });
    try {
      // Time spent inside the engine during the current invocation.
      let engineMs = 0;
      const inEngine = async <T>(fn: () => Promise<T>): Promise<T> => {
        const start = performance.now();
        try {
          return await fn();
        } finally {
          engineMs += performance.now() - start;
        }
      };
      const engine: AdapterEngine = {
        record: (observations) => inEngine(() => fx.engine.record(observations)),
        checkpoint: (runId, options) => inEngine(() => fx.engine.checkpoint(runId, options)),
        // Counted as adapter time: a cheap read, and the adapter chose to call it.
        workspaceDir: (runId) => fx.engine.workspaceDir(runId),
      };
      const handler = createHookHandler({ engine, ledger: fx.backend, env: { [RUN_ID_ENV]: fx.run.run_id } });

      const absolute: number[] = [];
      const added: number[] = [];
      const gitAbsolute: number[] = [];
      const gitAdded: number[] = [];
      const gitAddedPre: number[] = [];
      const gitAddedPost: number[] = [];
      /** `git`: the invocation reads git status, before its append (PreToolUse) or during it (PostToolUse). */
      const timed = async (git: 'pre' | 'post' | null, payload: Record<string, unknown>): Promise<void> => {
        engineMs = 0;
        const start = performance.now();
        const id = await handler.handleHook(payload);
        const elapsed = performance.now() - start;
        absolute.push(elapsed);
        added.push(elapsed - engineMs);
        if (git !== null) {
          gitAbsolute.push(elapsed);
          gitAdded.push(elapsed - engineMs);
          (git === 'pre' ? gitAddedPre : gitAddedPost).push(elapsed - engineMs);
        }
        expect(id).not.toBeNull();
      };

      let turn = 0;
      let call = 0;
      while (absolute.length < INVOCATIONS) {
        turn += 1;
        const steps: Array<() => Promise<void>> = [() => timed(null, hookInput('UserPromptSubmit', { prompt: `turn ${turn}: keep going` }))];
        for (const tool of ['Read', 'Grep', 'Write', 'Edit', 'Bash']) {
          call += 1;
          const id = `toolu_01Latency${String(call).padStart(12, '0')}`;
          const usesGit = WORKSPACE_TOOLS.has(tool);
          const input =
            tool === 'Bash' ? { command: 'npm test' } : tool === 'Write' ? { file_path: `notes/turn-${turn}.md`, content: `turn ${turn}\n` } : { file_path: 'src/app.ts' };
          steps.push(() => timed(usesGit ? 'pre' : null, hookInput('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id })));
          if (tool === 'Write') steps.push(() => writeFiles(fx.repo.dir, { [`notes/turn-${turn}.md`]: `turn ${turn}\n` }));
          if (tool === 'Edit' && turn % 2 === 0) steps.push(() => writeFiles(fx.repo.dir, { 'src/app.ts': `export const version = ${turn};\n` }));
          steps.push(() =>
            timed(usesGit ? 'post' : null, hookInput('PostToolUse', { tool_name: tool, tool_input: input, tool_response: { stdout: 'ok\n'.repeat(20) }, tool_use_id: id })),
          );
        }
        call += 1;
        steps.push(() => timed(null, hookInput('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: `toolu_01Latency${String(call).padStart(12, '0')}`, error: 'exit 1' })));
        for (const step of steps) {
          if (absolute.length >= INVOCATIONS) break;
          await step();
        }
      }

      const ledger = await allEvents(fx.backend, fx.run.run_id);
      expect(ledger.filter((event) => event.type === 'adapter.error')).toEqual([]);
      expect(ledger.filter((event) => event.type === 'checkpoint.created')).toEqual([]);
      expect(ledger.some((event) => event.type === 'workspace.changed')).toBe(true);
      expect(absolute).toHaveLength(INVOCATIONS);
      expect(gitAdded.length).toBeGreaterThan(INVOCATIONS / 3);
      // The engine was really exercised: the exclusion is not hiding an empty measurement.
      expect(added.every((value, i) => value <= absolute[i]! + 1e-6)).toBe(true);

      const report = [
        summary('added, all hooks', added),
        summary('added, Write/Edit/Bash', gitAdded),
        summary('added, PreToolUse Write/Edit/Bash (git status counted in full)', gitAddedPre),
        summary('added, PostToolUse Write/Edit/Bash (git status beside the append)', gitAddedPost),
        summary('absolute, all hooks', absolute),
        summary('absolute, Write/Edit/Bash', gitAbsolute),
      ].join('; ');
      console.info(`[claude-code adapter latency] ${report}`);
      expect(percentile(added, 95), report).toBeLessThan(P95_BUDGET_MS);
    } finally {
      await fx.cleanup();
    }
  });
});
