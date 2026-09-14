/**
 * When a Write/Edit/Bash hook reads `git status` relative to the append it belongs to (SPEC-009 latency, DEC-044(4)).
 * - PreToolUse reads it BEFORE tool.requested is recorded, because that event carries the status digest.
 * - PostToolUse reads it WHILE tool.completed is being recorded (the tool has already run), so the hook costs about
 *   max(record, git status) rather than their sum.
 * GatedEngine behaves like the real Checkpoint Engine in the one respect that matters here: workspaceDir() is
 * serialized behind record() per run. Its record() also waits until the test releases it.
 */
import { describe, expect, it } from 'vitest';
import { createHookHandler, RUN_ID_ENV, workspaceStatusOf, type ReadWorkspaceStatus } from '../../../../src/adapters/claude-code/index.js';
import type { LedgerEvent, LedgerEventDraft } from '../../../../src/model/types.js';
import { FakeEngine, RUN_ID, fixture } from './support.js';

/** Resolves once pending promise jobs, and the immediates they schedule, have run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

class GatedEngine extends FakeEngine {
  readonly log: string[] = [];
  readonly #releases: Array<() => void> = [];
  #queue: Promise<unknown> = Promise.resolve();

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn, fn);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Number of record() calls currently held at the gate. */
  get held(): number {
    return this.#releases.length;
  }

  release(): void {
    for (const release of this.#releases.splice(0)) release();
  }

  override record(drafts: readonly LedgerEventDraft[]): Promise<LedgerEvent[]> {
    return this.#serial(async () => {
      this.log.push(`record ${drafts.map((draft) => draft.type).join(',')}`);
      await new Promise<void>((resolve) => this.#releases.push(resolve));
      return super.record(drafts);
    });
  }

  override workspaceDir(runId: string): Promise<string> {
    return this.#serial(() => super.workspaceDir(runId));
  }
}

function gatedHarness(): { engine: GatedEngine; handleHook: (payload: unknown) => Promise<string | null> } {
  const engine = new GatedEngine();
  const readWorkspaceStatus: ReadWorkspaceStatus = async () => {
    engine.log.push('git status');
    return workspaceStatusOf(Buffer.from('', 'utf8'));
  };
  const handler = createHookHandler({ engine, ledger: engine, env: { [RUN_ID_ENV]: RUN_ID }, readWorkspaceStatus, sleep: async () => undefined });
  return { engine, handleHook: (payload) => handler.handleHook(payload) };
}

describe('git status timing on Write/Edit/Bash', () => {
  it('PreToolUse reads git status before tool.requested is recorded', async () => {
    const { engine, handleHook } = gatedHarness();
    const pending = handleHook(fixture('pre-tool-use'));
    await settle();
    expect(engine.log).toEqual(['git status', 'record tool.requested']);
    engine.release();
    expect(await pending).not.toBeNull();
    expect(engine.observed.map((event) => event.type)).toEqual(['tool.requested']);
  });

  it('PostToolUse reads git status while tool.completed is still being recorded', async () => {
    const { engine, handleHook } = gatedHarness();
    const pending = handleHook(fixture('post-tool-use'));
    await settle();
    // The append is still held at the gate, and git status has already run.
    expect(engine.held).toBe(1);
    expect(engine.log).toContain('git status');
    expect(engine.log).toContain('record tool.completed');
    engine.release();
    const id = await pending;
    expect(engine.observed.map((event) => event.type)).toEqual(['tool.completed']);
    expect(id).toBe(engine.observed[0]!.event_id);
  });
});
