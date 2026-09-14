/**
 * DEC-030: the Checkpoint Engine's `distillRequest` port carries exactly the Distiller's DistillRequest (one
 * definition, owned by src/distill), with the run passed as port-call context. Messages emitted by a real
 * engine on a real LocalBackend are fed to S06's real distill(), so neither side can pass against its own stub.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import {
  BlobProjectionStore,
  createBudget,
  distill,
  distillRequestFor,
  storageSource,
  type DistillRequest,
  type DistillerProvider,
} from '../../../src/distill/index.js';
import type { DistillRequestPort } from '../../../src/engine/index.js';
import { engineFixture, flushImmediates, refOf, writeFiles } from './support.js';

interface Emitted {
  readonly message: DistillRequest;
  readonly context: { readonly runId: string };
}

function stubProvider(): DistillerProvider & { readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'stub',
    model: 'claude-haiku-4-5-20251001',
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      return { text: JSON.stringify({ claims: [] }), usage: { inputTokens: 12, outputTokens: 3, costUsd: 0 } };
    },
  };
}

describe('distillRequest port → Distiller (DEC-030)', () => {
  it('each labeled checkpoint emits distillRequestFor(checkpoint, same-run parent) with its run as context, and the real distill() accepts it', async () => {
    const emitted: Emitted[] = [];
    const port: DistillRequestPort = {
      request: (message, context) => {
        emitted.push({ message, context });
      },
    };
    const fx = await engineFixture({ files: { 'app.txt': 'v0\n' }, engine: { distill: port } });
    try {
      const runId = (await fx.engine.startRun({ agent: 'claude-code' })).run_id;
      const tool = (type: 'tool.requested' | 'tool.completed', id: string) => ({
        run_id: runId,
        type,
        actor: type === 'tool.requested' ? ('agent' as const) : ('runtime' as const),
        payload: { tool_call_id: id },
      });

      await fx.engine.record([tool('tool.requested', 'call_1')]);
      const c1 = await fx.engine.checkpoint(runId, { label: 'first' });
      await writeFiles(fx.repo.dir, { 'app.txt': 'v1\n' });
      await fx.engine.record([tool('tool.completed', 'call_1')]);
      const c2 = await fx.engine.checkpoint(runId);
      await writeFiles(fx.repo.dir, { 'app.txt': 'v2\n' });
      await fx.engine.record([tool('tool.requested', 'call_2'), tool('tool.completed', 'call_2')]);
      const c3 = await fx.engine.checkpoint(runId, { label: 'third' });

      const forked = await fx.engine.fork(refOf(c2));
      await writeFiles(fx.engine.worktreePath(forked.run_id), { 'app.txt': 'forked\n' });
      const f1 = await fx.engine.checkpoint(forked.run_id, { label: 'fork first' });

      await flushImmediates();

      // Labeled c_1, c_3 and the fork's first checkpoint; the unlabeled c_2 emits nothing.
      expect(emitted.map(({ message, context }) => [context.runId, message.checkpointId])).toEqual([
        [runId, 'c_1'],
        [runId, 'c_3'],
        [forked.run_id, 'c_1'],
      ]);
      expect([c1.parent_checkpoint_id, c2.parent_checkpoint_id, c3.parent_checkpoint_id, f1.parent_checkpoint_id]).toEqual([null, 'c_1', 'c_2', null]);

      // The message is the declared port and nothing more: no run id, no label.
      for (const { message } of emitted) expect(Object.keys(message).sort()).toEqual(['checkpointId', 'ledgerRange', 'stateHash', 'workspaceCommit']);
      expect(emitted.map(({ message }) => message.ledgerRange)).toEqual([
        [0, c1.ledger_seq],
        [c2.ledger_seq, c3.ledger_seq], // c_3's range starts at its parent c_2's cursor, not c_1's
        [0, f1.ledger_seq], // a fork's first checkpoint has no same-run parent
      ]);
      expect(c2.ledger_seq).toBeGreaterThan(c1.ledger_seq);

      for (const { message, context } of emitted) {
        const checkpoint = await fx.backend.getCheckpoint({ run_id: context.runId, checkpoint_id: message.checkpointId });
        const parent =
          checkpoint.parent_checkpoint_id === null
            ? null
            : await fx.backend.getCheckpoint({ run_id: context.runId, checkpoint_id: checkpoint.parent_checkpoint_id });
        expect(message).toEqual(distillRequestFor(checkpoint, parent));

        const provider = stubProvider();
        const result = await distill(message, {
          provider,
          source: storageSource(fx.backend, context.runId),
          store: new BlobProjectionStore(fx.backend),
          budget: createBudget(context.runId),
        });
        expect(provider.prompts).toHaveLength(1);
        expect(result.projection.checkpointId).toBe(message.checkpointId);
        expect(result.projection.input).toEqual({
          stateHash: message.stateHash,
          ledgerRange: [...message.ledgerRange],
          workspaceCommit: message.workspaceCommit,
        });
      }
    } finally {
      await fx.cleanup();
    }
  });
});
