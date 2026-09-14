/**
 * SPEC-008 truncation policy, with DEC-036(3)/(4): tokenEstimate <= maxTokens and equals ceil(canonical chars / 4);
 * an event is hydrated whole or dropped whole; an inline payload is never cut and never turned into a ref; a payload
 * already stored as a blob keeps its stored payload_ref with payload null.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETED_TOOL_INTENT_CAP,
  PENDING_TOOL_INTENT_CAP,
  createContextBuilder,
  hydrateEvent,
  intentGroup,
  isContextError,
  type IntentGroup,
} from '../../../src/context/index.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import type { LedgerEvent, PendingIntent } from '../../../src/model/types.js';
import {
  MemoryStorage,
  checkpointAt,
  claim,
  contextChars,
  fakeGit,
  omittedCount,
  restoredAt,
  sealEvents,
  sealFakeLedger,
  sha256,
  staticClaims,
  type Draft,
} from './support.js';

/** `{"stdout":"<k x>"}` is 13 + k bytes of canonical JSON. */
const exactly4096 = { stdout: 'x'.repeat(4083) };
const oneOver = { stdout: 'x'.repeat(4084) };

function mixedLedger(): LedgerEvent[] {
  const drafts: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
  const sizes = [12, 900, 3000, 5000, 20_000, 64_000];
  for (let i = 1; i <= 300; i += 1) {
    drafts.push({ type: 'tool.requested', actor: 'agent', payload: { tool_call_id: `call_${i}`, tool: 'Bash', input: { command: `npm test -- --shard=${i}` } } });
    if (i % 50 === 0) {
      // Offloaded by the ledger: the payload is a CAS blob.
      drafts.push({ type: 'tool.completed', payload: null, payload_ref: { sha256: sha256(`blob:call_${i}`), size: 2_000_000 + i } });
    } else {
      drafts.push({
        type: i % 11 === 0 ? 'tool.failed' : 'tool.completed',
        payload: { tool_call_id: `call_${i}`, stdout: `line ${i}\n`.repeat(Math.ceil((sizes[i % sizes.length] ?? 12) / 8)) },
      });
    }
  }
  drafts.push({ type: 'workspace.changed', payload: exactly4096 });
  drafts.push({ type: 'workspace.changed', payload: oneOver });
  drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } });
  return sealEvents(drafts);
}

function mustFind<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`fixture has no ${what}`);
  return value;
}

describe('token budget', () => {
  const events = mixedLedger();
  const byId = new Map(events.map((event) => [event.event_id, event]));
  const checkpoint = checkpointAt({ n: 1, ledgerSeq: events.length });
  const builder = (): ReturnType<typeof createContextBuilder> => createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit() });

  it.each([2000, 8000, 32000])('tokenEstimate <= maxTokens %i, equals ceil(canonical chars / 4), and every hydrated event is whole', async (maxTokens) => {
    const context = await builder().buildResumeContext(restoredAt(checkpoint, events), { maxTokens });

    expect(context.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    expect(context.tokenEstimate).toBe(Math.ceil(contextChars(context) / 4));
    if (maxTokens > 2000) expect(context.hydratedEvents.length).toBeGreaterThan(0);

    for (const hydrated of context.hydratedEvents) {
      const original = mustFind(byId.get(hydrated.event_id), `event ${hydrated.event_id}`);
      const { payload, payload_ref, ...envelope } = hydrated;
      const { payload: originalPayload, payload_ref: originalRef, ...originalEnvelope } = original;
      expect(envelope).toEqual(originalEnvelope);
      if (originalRef === null) {
        // Inline, byte for byte as recorded, whatever its size.
        expect(canonicalJSON(payload)).toBe(canonicalJSON(originalPayload));
        expect(payload_ref).toBeNull();
      } else {
        // Already a blob: the stored ref, never read.
        expect(payload).toBeNull();
        expect(payload_ref).toEqual(originalRef);
      }
    }
  });

  it('hydrates an over-4 KB inline payload whole and a stored blob payload by its stored ref (maxTokens 32000)', async () => {
    const context = await builder().buildResumeContext(restoredAt(checkpoint, events), { maxTokens: 32000 });
    const bySeq = new Map(context.hydratedEvents.map((event) => [event.seq, event]));

    const overLimit = mustFind(events.at(-2), 'over-limit event');
    expect(Buffer.byteLength(canonicalJSON(overLimit.payload), 'utf8')).toBe(4097);
    expect(bySeq.get(overLimit.seq)?.payload).toEqual(oneOver);
    expect(bySeq.get(overLimit.seq)?.payload_ref).toBeNull();

    const stored = mustFind(
      events.filter((event) => event.payload_ref !== null).at(-1),
      'stored blob event',
    );
    expect(bySeq.get(stored.seq)?.payload).toBeNull();
    expect(bySeq.get(stored.seq)?.payload_ref).toEqual(stored.payload_ref);
  });

  it('hydrates inline payloads whole at any size, keeps a stored payload_ref, and never makes one up', () => {
    const atLimit = mustFind(events.at(-3), 'at-limit event');
    const overLimit = mustFind(events.at(-2), 'over-limit event');
    const largest = mustFind(
      events.find((event) => event.payload !== null && canonicalJSON(event.payload).length > 60_000),
      '64 KB inline event',
    );
    for (const event of [atLimit, overLimit, largest]) {
      expect(hydrateEvent(event)).toEqual(event);
      expect(hydrateEvent(event).payload_ref).toBeNull();
    }

    const stored = mustFind(
      events.find((event) => event.payload_ref !== null),
      'stored blob event',
    );
    expect(hydrateEvent(stored)).toEqual(stored);
    // A record carrying both keeps only its stored ref, and the builder still never reads the blob.
    expect(hydrateEvent({ ...stored, payload: { stdout: 'inline copy' } })).toEqual(stored);
  });

  it('drops an event that does not fit whole and still hydrates the smaller candidates after it', async () => {
    const drafts: Draft[] = [{ type: 'run.created', payload: { agent: 'claude-code' } }];
    for (let i = 2; i <= 40; i += 1) drafts.push({ type: 'workspace.changed', payload: { paths: [`src/file-${i}.ts`] } });
    drafts.push({ type: 'model.responded', payload: { request_id: 'req_big', text: 'y'.repeat(40_000) } }); // seq 41, ~10k tokens inline
    drafts.push({ type: 'workspace.changed', payload: { paths: ['src/last.ts'] } }); // seq 42
    drafts.push({ type: 'checkpoint.created', payload: { checkpoint_id: 'c_1' } }); // seq 43
    const ledger = sealEvents(drafts);
    const head = checkpointAt({ n: 1, ledgerSeq: ledger.length });
    const big = mustFind(ledger[40], 'large event');
    const make = (): ReturnType<typeof createContextBuilder> => createContextBuilder({ storage: new MemoryStorage(ledger, [head]), git: fakeGit() });

    const tight = await make().buildResumeContext(restoredAt(head, ledger), { maxTokens: 8000 });
    const seqs = tight.hydratedEvents.map((event) => event.seq);
    expect(seqs).not.toContain(big.seq);
    expect(seqs.slice(0, 2)).toEqual([43, 42]);
    // Older than the dropped event, and hydrated anyway.
    expect(seqs).toContain(40);
    expect(seqs).toContain(2);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(tight.tokenEstimate).toBeLessThanOrEqual(8000);
    // The preamble counts the one delta event it left out for size.
    expect(tight.systemPreamble).toContain('left out because they do not fit whole: cited 0, last failure 0, delta 1');

    const roomy = await make().buildResumeContext(restoredAt(head, ledger), { maxTokens: 32000 });
    expect(roomy.hydratedEvents.find((event) => event.seq === big.seq)?.payload).toEqual(big.payload);
    expect(roomy.tokenEstimate).toBeLessThanOrEqual(32000);
    expect(roomy.systemPreamble).toContain('left out because they do not fit whole: cited 0, last failure 0, delta 0');
  });

  it.each([2000, 8000, 32000])(
    'adds Tier 3 in priority order; every candidate left out before the last one added did not fit whole at its turn (maxTokens %i)',
    async (maxTokens) => {
      const context = await builder().buildResumeContext(restoredAt(checkpoint, events), { maxTokens });
      // No claims: the last failure first, then the delta (the whole run, no parent) newest first.
      const lastFailure = mustFind(
        events.filter((event) => event.type === 'tool.failed').at(-1),
        'failure',
      );
      const candidates = [lastFailure, ...[...events].reverse()];
      const hydrated = context.hydratedEvents;

      const running: LedgerEvent[] = [];
      let next = 0;
      for (const candidate of candidates) {
        if (next === hydrated.length) break;
        if (candidate.event_id === hydrated[next]?.event_id) {
          running.push(mustFind(hydrated[next], 'hydrated event'));
          next += 1;
          continue;
        }
        if (running.some((event) => event.event_id === candidate.event_id)) continue;
        expect(Math.ceil(contextChars(context, [...running, hydrateEvent(candidate)]) / 4)).toBeGreaterThan(maxTokens);
      }
      // hydratedEvents is a subsequence of the priority order.
      expect(next).toBe(hydrated.length);
    },
  );

  it.each([2000, 8000, 32000])('stays within maxTokens %i over a 5,000-event fakeLedgerEvents run, with the recorded state not shrunk', async (maxTokens) => {
    const ledger = sealFakeLedger(5000, 3);
    const runId = ledger[0]?.run_id ?? '';
    const c1 = checkpointAt({ n: 1, ledgerSeq: 2000, runId });
    const c2 = checkpointAt({ n: 2, ledgerSeq: 5000, parent: c1 });
    const restored = restoredAt(c2, ledger);
    const recorded = restored.state.pending_intent;
    expect(recorded.length).toBeGreaterThan(1000);
    const ledgerById = new Map(ledger.map((event) => [event.event_id, event]));

    const context = await createContextBuilder({ storage: new MemoryStorage(ledger, [c1, c2]), git: fakeGit() }).buildResumeContext(restored, { maxTokens });

    expect(context.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    expect(context.tokenEstimate).toBe(Math.ceil(contextChars(context) / 4));
    const count = (list: readonly PendingIntent[], group: IntentGroup): number => list.filter((intent) => intentGroup(intent) === group).length;
    const listed = context.state.pending_intent;
    expect(count(listed, 'never_dropped')).toBe(count(recorded, 'never_dropped'));
    expect(count(listed, 'pending')).toBeLessThanOrEqual(PENDING_TOOL_INTENT_CAP);
    expect(count(listed, 'completed')).toBeLessThanOrEqual(COMPLETED_TOOL_INTENT_CAP);
    expect(count(listed, 'pending') + omittedCount(context.systemPreamble, 'failed tool actions')).toBe(count(recorded, 'pending'));
    expect(count(listed, 'completed') + omittedCount(context.systemPreamble, 'completed tool actions')).toBe(count(recorded, 'completed'));
    if (maxTokens === 32000) {
      expect(count(listed, 'pending')).toBe(PENDING_TOOL_INTENT_CAP);
      expect(count(listed, 'completed')).toBe(COMPLETED_TOOL_INTENT_CAP);
      expect(context.hydratedEvents.length).toBeGreaterThan(0);
    }
    for (const event of context.hydratedEvents) {
      expect(event).toEqual(hydrateEvent(mustFind(ledgerById.get(event.event_id), `event ${event.event_id}`)));
    }
  });

  it('uses maxTokens 8000 by default', async () => {
    const restored = restoredAt(checkpoint, events);
    const byDefault = await builder().buildResumeContext(restored);
    expect(JSON.stringify(byDefault)).toBe(JSON.stringify(await builder().buildResumeContext(restored, { maxTokens: 8000 })));
    expect(byDefault.tokenEstimate).toBeLessThanOrEqual(8000);
  });

  it('rejects with ERR_BUDGET when the never-dropped goal claims alone exceed maxTokens', async () => {
    const goals = Array.from({ length: 300 }, (_, i) => claim('goal', `Goal ${i}: ${'because '.repeat(25)}`, [events[1]?.event_id ?? 'evt_000002']));
    const withGoals = createContextBuilder({ storage: new MemoryStorage(events, [checkpoint]), git: fakeGit(), claims: staticClaims(goals) });
    const restored = restoredAt(checkpoint, events);

    const error = await withGoals.buildResumeContext(restored, { maxTokens: 2000 }).catch((err: unknown) => err);
    expect(isContextError(error, 'ERR_BUDGET')).toBe(true);

    const roomy = await withGoals.buildResumeContext(restored, { maxTokens: 32000 });
    expect(roomy.tokenEstimate).toBeLessThanOrEqual(32000);
  });

  it('rejects a maxTokens that is not a positive integer', async () => {
    const restored = restoredAt(checkpoint, events);
    for (const maxTokens of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8000']) {
      const error = await builder()
        .buildResumeContext(restored, { maxTokens: maxTokens as number })
        .catch((err: unknown) => err);
      expect(isContextError(error, 'ERR_INVALID_INPUT')).toBe(true);
    }
  });
});
