/**
 * SPEC-009 criterion: handleHook p95 < 50 ms over 1000 non-boundary invocations (checkpoint boundaries excluded).
 *
 * Real engine, LocalBackend and `git status` in a throwaway repository (tests/helpers/tmpRepo.ts), one bound run, and a
 * realistic hook mix repeated per turn: a prompt, then PreToolUse/PostToolUse pairs for Read, Grep, Write, Edit and
 * Bash, and a PostToolUseFailure. Write/Edit/Bash read git status (DEC-044(4)): the Write really creates a file every
 * turn and every other Edit changes one, so workspace.changed is written too. Every invocation is timed individually,
 * from the call to the resolved EventId. The overall p95 is the criterion; the git-status path's p95 is reported
 * alongside it.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });
import { performance } from 'node:perf_hooks';
import { WORKSPACE_TOOLS } from '../../../../src/adapters/claude-code/index.js';
import { allEvents, writeFiles } from '../../engine/support.js';
import { adapterFixture, hookInput } from './support.js';

const INVOCATIONS = 1000;
const P95_BUDGET_MS = 50;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function summary(label: string, values: readonly number[]): string {
  return `${label}: n=${values.length} p50=${percentile(values, 50).toFixed(1)} ms p95=${percentile(values, 95).toFixed(1)} ms max=${percentile(values, 100).toFixed(1)} ms`;
}

describe('hook latency', () => {
  it(`handleHook p95 < ${P95_BUDGET_MS} ms over ${INVOCATIONS} non-boundary invocations`, async () => {
    const fx = await adapterFixture({ 'README.md': '# app\n', 'src/app.ts': 'export const version = 0;\n' });
    try {
      const all: number[] = [];
      const gitPath: number[] = [];
      const timed = async (usesGit: boolean, payload: Record<string, unknown>): Promise<void> => {
        const start = performance.now();
        const id = await fx.handler.handleHook(payload);
        const elapsed = performance.now() - start;
        all.push(elapsed);
        if (usesGit) gitPath.push(elapsed);
        expect(id).not.toBeNull();
      };

      let turn = 0;
      let call = 0;
      while (all.length < INVOCATIONS) {
        turn += 1;
        const steps: Array<() => Promise<void>> = [() => timed(false, hookInput('UserPromptSubmit', { prompt: `turn ${turn}: keep going` }))];
        for (const tool of ['Read', 'Grep', 'Write', 'Edit', 'Bash']) {
          call += 1;
          const id = `toolu_01Latency${String(call).padStart(12, '0')}`;
          const usesGit = WORKSPACE_TOOLS.has(tool);
          const input =
            tool === 'Bash' ? { command: 'npm test' } : tool === 'Write' ? { file_path: `notes/turn-${turn}.md`, content: `turn ${turn}\n` } : { file_path: 'src/app.ts' };
          steps.push(() => timed(usesGit, hookInput('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id })));
          if (tool === 'Write') steps.push(() => writeFiles(fx.repo.dir, { [`notes/turn-${turn}.md`]: `turn ${turn}\n` }));
          if (tool === 'Edit' && turn % 2 === 0) steps.push(() => writeFiles(fx.repo.dir, { 'src/app.ts': `export const version = ${turn};\n` }));
          steps.push(() => timed(usesGit, hookInput('PostToolUse', { tool_name: tool, tool_input: input, tool_response: { stdout: 'ok\n'.repeat(20) }, tool_use_id: id })));
        }
        call += 1;
        steps.push(() => timed(false, hookInput('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: `toolu_01Latency${String(call).padStart(12, '0')}`, error: 'exit 1' })));
        for (const step of steps) {
          if (all.length >= INVOCATIONS) break;
          await step();
        }
      }

      const ledger = await allEvents(fx.backend, fx.run.run_id);
      expect(ledger.filter((event) => event.type === 'adapter.error')).toEqual([]);
      expect(ledger.filter((event) => event.type === 'checkpoint.created')).toEqual([]);
      expect(ledger.some((event) => event.type === 'workspace.changed')).toBe(true);
      expect(all).toHaveLength(INVOCATIONS);
      expect(gitPath.length).toBeGreaterThan(INVOCATIONS / 3);

      const report = `${summary('all hooks', all)}; ${summary('Write/Edit/Bash (git status)', gitPath)}`;
      console.info(`[claude-code adapter latency] ${report}`);
      expect(percentile(all, 95), report).toBeLessThan(P95_BUDGET_MS);
    } finally {
      await fx.cleanup();
    }
  });
});
