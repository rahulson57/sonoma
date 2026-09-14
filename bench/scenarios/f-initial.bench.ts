/**
 * SPEC-014 scenario F: 2 GB initial snapshot. Budget from the SPEC-002 table (bench/results.schema.ts).
 *
 * Workspace: ~2 GiB of mixed text and binary files, aged past the racy-clean window. Every iteration is a TRUE
 * initial snapshot: untimed, the previous iteration's store, checkpoint refs and git objects are removed and a
 * fresh store and run are opened; then checkpoint() call to ACK is measured.
 * Iterations: 3 (DEC-051(3)). The nearest-rank p95 of 3 samples is the largest one, so p95Ms is effectively the MAX.
 * Phases the harness cannot measure are null (see support/harness.ts).
 */
import { bench, describe } from 'vitest';
import { phaseRecorder } from '../phases.js';
import { agePastRacyWindow, emptyStore, GIB, measureCheckpoint, openStore, scenarioBench, writeMixedWorkspace, type Store } from './support/harness.js';

const SCENARIO = 'f-initial';

const recorder = phaseRecorder(SCENARIO);

const scenario = scenarioBench(SCENARIO, recorder, {
  async prepare(ws) {
    await writeMixedWorkspace(ws.dir, 2 * GIB);
    await agePastRacyWindow();
    return { ws, store: undefined as Store | undefined };
  },
  async iterate(state) {
    if (state.store !== undefined) await emptyStore(state.store);
    state.store = await openStore(state.ws.dir, state.ws.base);
    const run = await state.store.engine.startRun({ agent: `bench-${SCENARIO}` });
    return measureCheckpoint(state.store, run.run_id);
  },
});

describe(SCENARIO, () => {
  bench('checkpoint', scenario.run, { time: 0, iterations: 3, warmupTime: 0, warmupIterations: 0, ...scenario.options });
});
