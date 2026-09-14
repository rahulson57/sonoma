/**
 * The benchmark scenario harness's phase measurement, run at small scale so it fits in `npm test` while
 * `npm run bench` is advisory. It uses the REAL harness (ProbedBackend over the real LocalBackend and engine, with
 * the StorageFaults marks) exactly as the scenario benches do; only the payload and workspace are small.
 *
 * - Record-then-checkpoint (scenario D's measurement): scanRedact is reported (an UPPER BOUND, DEC-051(2)). record()
 *   makes exactly one getEvents (the engine's #view tail read) before its append, and that read must not make
 *   scanRedact unmeasurable. ledgerAppend and indexUpdate are null, because the observation's own append is a ledger
 *   append outside the seams.
 * - Checkpoint only: ledgerAppend and indexUpdate are reported, plus both DIAGNOSTIC merged spans (DEC-051(1)).
 * Every other phase is null, never 0 (DEC-049(1), DEC-050).
 *
 * The workspace lives under `<os tmpdir>/ckpt-bench.noindex/` (DEC-047(4)) and is removed afterwards.
 * Test titles avoid the literal scenario directory path: tests/unit/harness/vitest-config.test.ts greps `vitest list`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhaseDurations } from '../../../bench/phases.js';
import { PHASES } from '../../../bench/results.schema.js';
import {
  benchRepo,
  KIB,
  measureCheckpoint,
  measureRecordThenCheckpoint,
  openStore,
  Probe,
  secretHeavyOutput,
  type BenchRepo,
  type Store,
} from '../../../bench/scenarios/support/harness.js';

const SAMPLES = 3;

function expectOnly(phases: PhaseDurations, measured: readonly string[], label: string): void {
  expect(Object.keys(phases).sort(), label).toEqual([...PHASES].sort());
  for (const phase of PHASES) {
    const value = phases[phase];
    if (measured.includes(phase)) {
      expect(value, `${label} ${phase}`).not.toBeNull();
      expect(Number.isFinite(value) && (value as number) >= 0, `${label} ${phase} = ${value}`).toBe(true);
    } else {
      expect(value, `${label} ${phase}`).toBeNull();
    }
  }
}

describe('scenario harness probe', () => {
  it('counts reads and other calls before the first append separately, and ignores calls outside a window', () => {
    const probe = new Probe();
    probe.onRead();
    probe.onOther();
    probe.onAppend();

    const w = probe.open();
    probe.onRead();
    probe.onOther();
    probe.onAppend();
    probe.onRead();
    probe.onOther();
    probe.onAppend();
    probe.close();

    expect(w).toMatchObject({ creates: 0, appends: 2, readsBeforeFirstAppend: 1, otherCallsBeforeFirstAppend: 1 });
    expect(w.marks.firstAppend).toBeTypeOf('number');
  });
});

describe('scenario harness measurement over the real engine (small scale)', () => {
  let ws: BenchRepo | undefined;
  let store: Store | undefined;
  let runId = '';

  beforeAll(async () => {
    ws = await benchRepo('unit-harness-measurement');
    store = await openStore(ws.dir, ws.base);
    const run = await store.engine.startRun({ agent: 'bench-unit-harness' });
    runId = run.run_id;
    await store.engine.checkpoint(runId);
  });

  afterAll(async () => {
    try {
      await store?.close();
    } finally {
      ws?.removeSync();
    }
  });

  it('record then checkpoint reports scanRedact (despite the #view read), with ledgerAppend and indexUpdate null', async () => {
    const stdout = secretHeavyOutput(64 * KIB);
    for (let i = 0; i < SAMPLES; i += 1) {
      const toolCallId = `toolu_unit_${i}`;
      const sample = await measureRecordThenCheckpoint(store!, {
        run_id: runId,
        type: 'tool.completed',
        actor: 'runtime',
        intent_id: toolCallId,
        payload: { tool_call_id: toolCallId, stdout },
      });
      expectOnly(sample.phases, ['scanRedact'], `sample ${i}`);
      expect(sample.phases.scanRedact as number, `sample ${i}`).toBeGreaterThan(0);
      expect(sample.totalMs, `sample ${i}`).toBeGreaterThan(sample.phases.scanRedact as number);
      expect(sample.unattributed, `sample ${i}`).toBeNull();
    }
  });

  it('checkpoint only reports ledgerAppend, indexUpdate and both diagnostic spans', async () => {
    for (let i = 0; i < SAMPLES; i += 1) {
      const sample = await measureCheckpoint(store!, runId);
      expectOnly(sample.phases, ['ledgerAppend', 'indexUpdate'], `sample ${i}`);
      expect(sample.totalMs, `sample ${i}`).toBeGreaterThan(0);
      expect(sample.unattributed, `sample ${i}`).not.toBeNull();
      const { beforeStorage, storageToRef } = sample.unattributed!;
      for (const [name, value] of Object.entries({ beforeStorage, storageToRef })) {
        expect(Number.isFinite(value) && value >= 0, `sample ${i} ${name} = ${value}`).toBe(true);
      }
    }
  });
});
