/**
 * SPEC-014 scenario D: 10 MB secret-heavy tool output. Reported, not budgeted (budgetMs null in the SPEC-002
 * table); its scanRedact phase is reported.
 *
 * Each iteration records one `tool.completed` observation whose stdout is ~10 MiB with a fake credential from the
 * shared corpus on every other line, then takes the automatic checkpoint that carries it. The sample runs from the
 * record() call to the checkpoint ACK. scanRedact is an UPPER BOUND over record()'s pre-append window (the #view
 * getEvents tail read + sanitizePayload + O(1) validation), per DEC-062(1), which amends DEC-051(2):
 * "upper bound: includes the #view getEvents tail read". D reports no merged spans (DEC-051(1)).
 * Phases the harness cannot measure are null (see support/harness.ts).
 */
import { bench, describe } from 'vitest';
import { phaseRecorder } from '../phases.js';
import { agePastRacyWindow, measureRecordThenCheckpoint, MIB, openStore, scenarioBench, secretHeavyOutput } from './support/harness.js';

const SCENARIO = 'd-secret-output';

const recorder = phaseRecorder(SCENARIO);

const scenario = scenarioBench(SCENARIO, recorder, {
  async prepare(ws) {
    const stdout = secretHeavyOutput(10 * MIB);
    await agePastRacyWindow();
    const store = await openStore(ws.dir, ws.base);
    const run = await store.engine.startRun({ agent: `bench-${SCENARIO}` });
    await store.engine.checkpoint(run.run_id);
    return { store, runId: run.run_id, stdout };
  },
  async iterate({ store, runId, stdout }, i) {
    const toolCallId = `toolu_bench_${i}`;
    return measureRecordThenCheckpoint(store, {
      run_id: runId,
      type: 'tool.completed',
      actor: 'runtime',
      intent_id: toolCallId,
      payload: { tool_call_id: toolCallId, stdout },
    });
  },
});

describe(SCENARIO, () => {
  bench('checkpoint', scenario.run, { time: 0, iterations: 10, warmupTime: 0, warmupIterations: 1, ...scenario.options });
});
