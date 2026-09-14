/**
 * SPEC-014 scenario A: 2 GB workspace, 1 KB changed. Budget from the SPEC-002 table (bench/results.schema.ts).
 *
 * Workspace: ~2 GiB of mixed text and binary files, aged past the racy-clean window, with one untimed initial
 * checkpoint. Each iteration rewrites one 1 KiB text file (untimed), then measures checkpoint() call to ACK.
 * Phases the harness cannot measure are null (see support/harness.ts).
 */
import { bench, describe } from 'vitest';
import { phaseRecorder } from '../phases.js';
import { agePastRacyWindow, GIB, KIB, measureCheckpoint, openStore, rewriteTextFile, scenarioBench, writeMixedWorkspace } from './support/harness.js';

const SCENARIO = 'a-small-change';
const CHANGED = 'src/changing.txt';

const recorder = phaseRecorder(SCENARIO);

const scenario = scenarioBench(SCENARIO, recorder, {
  async prepare(ws) {
    await writeMixedWorkspace(ws.dir, 2 * GIB);
    await rewriteTextFile(ws.dir, CHANGED, 1 * KIB, 'initial');
    await agePastRacyWindow();
    const store = await openStore(ws.dir, ws.base);
    const run = await store.engine.startRun({ agent: `bench-${SCENARIO}` });
    await store.engine.checkpoint(run.run_id);
    return { store, runId: run.run_id };
  },
  async iterate({ store, runId }, i) {
    await rewriteTextFile(store.repoDir, CHANGED, 1 * KIB, `change ${i}`);
    return measureCheckpoint(store, runId);
  },
});

describe(SCENARIO, () => {
  bench('checkpoint', scenario.run, { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 2, ...scenario.options });
});
