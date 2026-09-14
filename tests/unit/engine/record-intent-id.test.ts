/**
 * SPEC-006 v3 "record() carries intent_id" (owned by S14 / SPEC-015): record() passes an observation's intent_id
 * through unchanged to the appended LedgerEvent. For a >1 MB tool.completed whose payload is offloaded to a CAS
 * blob_ref, the event keeps the same intent_id, so derivePendingIntent reports the intent completed.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { derivePendingIntent } from '../../../src/ledger/pending-intent.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import type { LedgerEventDraft } from '../../../src/model/types.js';
import { allEvents, engineFixture } from '../../integration/engine/support.js';

// Shaped like a Claude Code tool_use_id: passed through verbatim, never rewritten.
const TOOL_USE_ID = 'toolu_01A09aZq7XbKc3Lm8Np2Rs4Tv6';

describe('record() carries intent_id', () => {
  it('appends events carrying the same intent_id; an offloaded >1 MB tool.completed keeps its blob_ref and intent_id, and derivePendingIntent reports it completed', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const [requested, completed] = await fx.engine.record([
        { run_id: run.run_id, type: 'tool.requested', actor: 'agent', intent_id: TOOL_USE_ID, payload: { tool: 'Bash', input: { command: 'cat build.log' } } },
        { run_id: run.run_id, type: 'tool.completed', actor: 'runtime', intent_id: TOOL_USE_ID, payload: { stdout: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 1) } },
      ]);

      expect(requested!.intent_id).toBe(TOOL_USE_ID);
      expect(completed!.intent_id).toBe(TOOL_USE_ID);
      expect(completed!.payload).toBeNull();
      expect(completed!.payload_ref).not.toBeNull();
      expect(completed!.payload_ref!.size).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES);

      // As stored: same members, chain intact, intent completed.
      const stored = await allEvents(fx.backend, run.run_id);
      expect(stored.filter((event) => event.intent_id === TOOL_USE_ID)).toEqual([requested, completed]);
      expect(verifyChain(stored)).toEqual({ ok: true });
      expect(derivePendingIntent(stored)).toEqual([
        { kind: 'tool', intent_id: TOOL_USE_ID, request_event_id: requested!.event_id, status: 'completed', requested_seq: requested!.seq, resolved_seq: completed!.seq },
      ]);

      // The checkpoint's deterministic state agrees: the acknowledged action is not reported in_progress.
      const checkpoint = await fx.engine.checkpoint(run.run_id);
      const state = await fx.backend.getState(checkpoint);
      expect(state.pending_intent).toEqual([expect.objectContaining({ kind: 'tool', intent_id: TOOL_USE_ID, status: 'completed' })]);
    } finally {
      await fx.cleanup();
    }
  });

  it('an observation without intent_id gets intent_id null, and a malformed intent_id is refused before anything is appended', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const before = await allEvents(fx.backend, run.run_id);

      for (const bad of ['', 42, { id: 'toolu_x' }]) {
        await expect(
          fx.engine.record([{ run_id: run.run_id, type: 'tool.requested', actor: 'agent', intent_id: bad, payload: {} } as unknown as LedgerEventDraft]),
        ).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
      }
      expect(await allEvents(fx.backend, run.run_id)).toEqual(before);

      const [plain, explicitNull] = await fx.engine.record([
        { run_id: run.run_id, type: 'agent.started', actor: 'runtime', payload: {} },
        { run_id: run.run_id, type: 'model.requested', actor: 'agent', intent_id: null, payload: { request_id: 'req_1' } },
      ]);
      expect(plain!.intent_id).toBeNull();
      expect(explicitNull!.intent_id).toBeNull();
      expect(verifyChain(await allEvents(fx.backend, run.run_id))).toEqual({ ok: true });
    } finally {
      await fx.cleanup();
    }
  });
});
