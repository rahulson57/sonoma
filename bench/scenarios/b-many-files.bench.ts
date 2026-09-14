/**
 * SPEC-014 scenario B: 100k files, 10 changed. Budget from the SPEC-002 table (bench/results.schema.ts).
 *
 * Workspace: 100,000 small text files, aged past the racy-clean window, with one untimed initial checkpoint. Each
 * iteration rewrites 10 files spread across the tree (untimed), then measures checkpoint() call to ACK.
 * Phases the harness cannot measure are null (see support/harness.ts).
 */
import { bench, describe } from 'vitest';
import { phaseRecorder } from '../phases.js';
import { agePastRacyWindow, manyFilesPath, measureCheckpoint, openStore, rewriteTextFile, scenarioBench, writeManyFilesWorkspace } from './support/harness.js';

const SCENARIO = 'b-many-files';
const FILES = 100_000;
const CHANGED_PER_CHECKPOINT = 10;

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
  async iterate({ store, runId }, i) {
    for (let k = 0; k < CHANGED_PER_CHECKPOINT; k += 1) {
      // A different, spread-out set of files each iteration.
      const index = (i * CHANGED_PER_CHECKPOINT + k) * 9_973 % FILES;
      await rewriteTextFile(store.repoDir, manyFilesPath(index), 512, `change ${i}.${k}`);
    }
    return measureCheckpoint(store, runId);
  },
});

describe(SCENARIO, () => {
  bench('checkpoint', scenario.run, { time: 0, iterations: 20, warmupTime: 0, warmupIterations: 2, ...scenario.options });
});
