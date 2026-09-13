/**
 * SPEC-006 / DEC-006: a labelled checkpoint emits exactly one fire-and-forget `distillRequest`; an unlabelled
 * one emits none; and checkpoint() itself never reaches a distiller provider.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import type { DistillRequest, DistillRequestPort } from '../../../src/engine/index.js';
import type { DistillerProvider } from '../../helpers/providerStub.js';
import { engineFixture, flushImmediates, writeFiles } from '../../integration/engine/support.js';

function spyProvider(): DistillerProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    name: 'spy',
    model: 'claude-haiku-4-5-20251001',
    complete: vi.fn(async () => ({ text: '{}', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })),
  };
}

describe('distillation trigger', () => {
  it('an unlabeled checkpoint emits no distillRequest and a labeled one emits exactly one, with a spy provider call count of 0 inside checkpoint()', async () => {
    const provider = spyProvider();
    const requests: DistillRequest[] = [];
    let insideCheckpoint = false;
    let providerCallsInsideCheckpoint = 0;
    // A port that would distill straight away: it calls the provider as soon as it gets a request.
    const port: DistillRequestPort = {
      request: vi.fn((message: DistillRequest) => {
        requests.push(message);
        if (insideCheckpoint) providerCallsInsideCheckpoint += 1;
        void provider.complete(`distill ${message.checkpoint_id}`);
      }),
    };
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' }, engine: { distill: port } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });

      insideCheckpoint = true;
      const unlabeled = await fx.engine.checkpoint(run.run_id);
      insideCheckpoint = false;
      expect(unlabeled.label).toBeNull();
      expect(provider.complete).toHaveBeenCalledTimes(0);
      await flushImmediates();
      expect(port.request).toHaveBeenCalledTimes(0);
      expect(provider.complete).toHaveBeenCalledTimes(0);

      await writeFiles(fx.repo.dir, { 'a.txt': 'b\n' });
      insideCheckpoint = true;
      const labeled = await fx.engine.checkpoint(run.run_id, { label: 'milestone: tests pass' });
      insideCheckpoint = false;
      expect(labeled.label).toBe('milestone: tests pass');
      expect(provider.complete).toHaveBeenCalledTimes(0);
      expect(port.request).toHaveBeenCalledTimes(0);

      await flushImmediates();
      expect(port.request).toHaveBeenCalledTimes(1);
      expect(requests).toEqual([
        {
          run_id: run.run_id,
          checkpoint_id: labeled.checkpoint_id,
          label: 'milestone: tests pass',
          ledger_seq: labeled.ledger_seq,
          state_hash: labeled.state_hash,
          workspace_commit: labeled.workspace_commit,
        },
      ]);
      expect(providerCallsInsideCheckpoint).toBe(0);
      // The only provider call is the port's own, made after checkpoint() had returned.
      expect(provider.complete).toHaveBeenCalledTimes(1);

      // Another unlabeled checkpoint adds nothing.
      await fx.engine.checkpoint(run.run_id, { label: null });
      await flushImmediates();
      expect(port.request).toHaveBeenCalledTimes(1);
    } finally {
      await fx.cleanup();
    }
  });

  it('a failing port neither delays nor fails the checkpoint', async () => {
    const throwing: DistillRequestPort = {
      request: vi.fn(() => {
        throw new Error('distiller offline');
      }),
    };
    const rejecting: DistillRequestPort = { request: vi.fn(() => Promise.reject(new Error('budget exceeded'))) };
    for (const port of [throwing, rejecting]) {
      const fx = await engineFixture({ files: { 'a.txt': 'a\n' }, engine: { distill: port } });
      try {
        const run = await fx.engine.startRun({ agent: 'claude-code' });
        const checkpoint = await fx.engine.checkpoint(run.run_id, { label: 'handoff' });
        expect(checkpoint.checkpoint_id).toBe('c_1');
        await flushImmediates();
        expect(port.request).toHaveBeenCalledTimes(1);
        expect(await fx.backend.listCheckpoints(run.run_id)).toEqual([checkpoint]);
      } finally {
        await fx.cleanup();
      }
    }
  });
});
