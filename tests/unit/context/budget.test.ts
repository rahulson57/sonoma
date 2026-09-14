/**
 * SPEC-008 truncation policy: tokenEstimate <= maxTokens, payloads are never cut mid-content, payloads over 4 KB are
 * referenced by sha256, and Tier 3 stops at the first event that does not fit whole.
 */
import { describe, expect, it } from 'vitest';
import { createContextBuilder, hydrateEvent, isContextError } from '../../../src/context/index.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import type { LedgerEvent } from '../../../src/model/types.js';
import { MemoryStorage, checkpointAt, claim, contextChars, fakeGit, restoredAt, sealEvents, sha256, staticClaims, type Draft } from './support.js';

/** `{"stdout":"<k x>"}` is 13 + k bytes of canonical JSON. */
const exactly4096 = { stdout: 'x'.repeat(4083) };
const oneOver = { stdout: 'x'.repeat(4084) };

function mixedLedger(): LedgerEvent[] {
  const drafts: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
  const sizes = [12, 900, 3000, 5000, 20_000, 64_000];
  for (let i = 1; i <= 300; i += 1) {
    drafts.push({ type: 'tool.requested', actor: 'agent', payload: { tool_call_id: `call_${i}`, tool: 'Bash', input: { command: `npm test -- --shard=${i}` } } });
    drafts.push({
      type: i % 11 === 0 ? 'tool.failed' : 'tool.completed',
      payload: { tool_call_id: `call_${i}`, stdout: `line ${i}\n`.repeat(Math.ceil((sizes[i % sizes.length] ?? 12) / 8)) },
    });
  }
  drafts.push({ type: 'workspace.changed', payload: exactly4096 });
  drafts.push({ type: 'workspace.changed', payload: oneOver });
  drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } });
  return sealEvents(drafts);
}

describe('token budget', () => {
  const events = mixedLedger();
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const checkpoint = checkpointAt({ n: 1, ledgerSeq: events.length });

  it.each([2000, 8000, 32000])('tokenEstimate <= maxTokens %i, equals ceil(chars / 4), and no payload is cut', async (maxTokens) => {
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });
    const context = await builder.buildResumeContext(restoredAt(checkpoint, events), { maxTokens });

    expect(context.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    expect(context.tokenEstimate).toBe(Math.ceil(contextChars(context) / 4));
    expect(context.hydratedEvents.length).toBeGreaterThan(0);

    for (const hydrated of context.hydratedEvents) {
      const original = byId.get(hydrated.event_id);
      if (original === undefined) throw new Error(`hydrated unknown event ${hydrated.event_id}`);
      const { payload, payload_ref, ...envelope } = hydrated;
      const { payload: originalPayload, payload_ref: originalRef, ...originalEnvelope } = original;
      expect(envelope).toEqual(originalEnvelope);
      expect(originalRef).toBeNull();
      const bytes = Buffer.byteLength(canonicalJSON(originalPayload), 'utf8');
      if (bytes <= 4096) {
        // Inline, byte for byte as recorded.
        expect(canonicalJSON(payload)).toBe(canonicalJSON(originalPayload));
        expect(payload_ref).toBeNull();
      } else {
        // Referenced whole, never truncated.
        expect(payload).toBeNull();
        expect(payload_ref).toEqual({ sha256: sha256(canonicalJSON(originalPayload)), size: bytes });
      }
    }
  });

  it('keeps a 4096-byte payload inline and references a 4097-byte payload by sha256', () => {
    const [atLimit, overLimit] = events.slice(-3, -1);
    if (atLimit === undefined || overLimit === undefined) throw new Error('fixture missing boundary events');

    expect(hydrateEvent(atLimit).payload).toEqual(exactly4096);
    expect(hydrateEvent(atLimit).payload_ref).toBeNull();
    expect(hydrateEvent(overLimit).payload).toBeNull();
    expect(hydrateEvent(overLimit).payload_ref).toEqual({ sha256: sha256(canonicalJSON(oneOver)), size: 4097 });
  });

  it.each([2000, 8000])('adds Tier 3 in priority order until the next event would exceed maxTokens %i', async (maxTokens) => {
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });
    const context = await builder.buildResumeContext(restoredAt(checkpoint, events), { maxTokens });

    // No claims: the last failure first, then every other event newest first.
    const lastFailure = events.filter((event) => event.type === 'tool.failed').at(-1);
    if (lastFailure === undefined) throw new Error('fixture has no failure');
    const candidates = [lastFailure, ...[...events].reverse().filter((event) => event.event_id !== lastFailure.event_id)];
    const n = context.hydratedEvents.length;

    expect(context.hydratedEvents.map((event) => event.event_id)).toEqual(candidates.slice(0, n).map((event) => event.event_id));
    const next = candidates[n];
    if (next === undefined) throw new Error('budget admitted every event; pick a smaller maxTokens');
    expect(Math.ceil(contextChars(context, [...context.hydratedEvents, hydrateEvent(next)]) / 4)).toBeGreaterThan(maxTokens);
  });

  it('uses maxTokens 8000 by default', async () => {
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });
    const restored = restoredAt(checkpoint, events);

    const byDefault = await builder.buildResumeContext(restored);
    expect(JSON.stringify(byDefault)).toBe(JSON.stringify(await builder.buildResumeContext(restored, { maxTokens: 8000 })));
    expect(byDefault.tokenEstimate).toBeLessThanOrEqual(8000);
  });

  it('rejects with ERR_BUDGET rather than emit a context whose Tier 1 + Tier 2 exceed maxTokens', async () => {
    const claims = Array.from({ length: 300 }, (_, i) => claim('decision', `Decision ${i}: ${'because '.repeat(25)}`, [events[1]?.event_id ?? '']));
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit(), claims: staticClaims(claims) });
    const restored = restoredAt(checkpoint, events);

    const error = await builder.buildResumeContext(restored, { maxTokens: 2000 }).catch((err: unknown) => err);
    expect(isContextError(error, 'ERR_BUDGET')).toBe(true);

    const roomy = await builder.buildResumeContext(restored, { maxTokens: 32000 });
    expect(roomy.tokenEstimate).toBeLessThanOrEqual(32000);
  });

  it('rejects a maxTokens that is not a positive integer', async () => {
    const builder = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });
    const restored = restoredAt(checkpoint, events);
    for (const maxTokens of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8000']) {
      const error = await builder.buildResumeContext(restored, { maxTokens: maxTokens as number }).catch((err: unknown) => err);
      expect(isContextError(error, 'ERR_INVALID_INPUT')).toBe(true);
    }
  });
});
