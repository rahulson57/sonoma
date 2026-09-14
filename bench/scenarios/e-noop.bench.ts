/**
 * SPEC-014 scenario E: no-op checkpoint (nothing changed). Budget from the SPEC-002 table (bench/results.schema.ts).
 *
 * Workspace: the same shape as scenario B (100,000 small text files; coordinator guidance MSG-3492: B and E on the
 * same 100k-file workspace, never shrunk to fit a budget), aged past the racy-clean window, with one untimed
 * initial checkpoint. Each iteration changes nothing and measures checkpoint() call to ACK.
 * Phases the harness cannot measure are null (see support/harness.ts).
 */
import { bench, describe } from 'vitest';
import { phaseRecorder } from '../phases.js';
import { agePastRacyWindow, measureCheckpoint, openStore, scenarioBench, writeManyFilesWorkspace } from './support/harness.js';

const SCENARIO = 'e-noop';
const FILES = 100_000;

const recorder = phaseRecorder(SCENARIO);

const scenario = scenarioBench(SCENARIO, recorder, {
  async prepare(ws) {
    await writeManyFilesWorkspace(ws.dir, FILES);
    await agePastRacyWindow();
    const store = await openStore(ws.dir, ws.base);
    const run = await store.engine.startRun({ agent: `bench-${SCENARIO}` });
    await store.engine.checkpoint(run.run_id);
    return { store, runId: run.run_id };
  },
  async iterate({ store, runId }) {
    return measureCheckpoint(store, runId);
  },
});

describe(SCENARIO, () => {
  bench('checkpoint', scenario.run, { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 2, ...scenario.options });
});
