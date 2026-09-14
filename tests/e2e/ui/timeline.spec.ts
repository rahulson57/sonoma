/**
 * SPEC-012: the timeline page renders 200 checkpoints with first paint < 1.5 s.
 * Run with `npx playwright test tests/e2e/ui`.
 *
 * The store is a real one: 200 checkpoints written through LocalBackend + CheckpointEngine, then read by an inspector
 * with its own backend. Timings come from the page's Performance API: `first-contentful-paint`, and the
 * `ckpt:timeline-rendered` mark the page sets once all timeline nodes are in the DOM.
 */
import { expect, test } from '@playwright/test';
import { CheckpointEngine } from '../../../src/engine/index.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { readRunRecords, startInspector, type InspectorHandle } from '../../../src/ui/index.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

const CHECKPOINTS = 200;
const FIRST_PAINT_BUDGET_MS = 1_500;

let repo: TmpGitRepo | undefined;
let reader: LocalBackend | undefined;
let inspector: InspectorHandle | undefined;
let runId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(900_000);
  repo = await tmpGitRepo({ files: { 'README.md': 'timeline fixture\n' } });
  const writer = await LocalBackend.open({ repoDir: repo.dir });
  try {
    const engine = await CheckpointEngine.open({ backend: writer, repoDir: repo.dir });
    runId = (await engine.startRun({ agent: 'claude-code' })).run_id;
    for (let i = 1; i <= CHECKPOINTS; i += 1) {
      await engine.checkpoint(runId, i % 25 === 0 ? { label: `milestone ${i}` } : {});
    }
  } finally {
    await writer.close();
  }
  const backend = await LocalBackend.open({ repoDir: repo.dir });
  reader = backend;
  const engine = await CheckpointEngine.open({ backend, repoDir: repo.dir });
  inspector = await startInspector({ port: 0, backend, engine, listRuns: () => readRunRecords(backend.layout.runs) });
});

test.afterAll(async () => {
  await inspector?.close();
  await reader?.close();
  await repo?.cleanup();
});

test('timeline page renders 200 checkpoints with first paint < 1.5 s', async ({ page }) => {
  if (inspector === undefined) throw new Error('inspector did not start');
  const origin = new URL(inspector.url).origin;
  const foreignRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) foreignRequests.push(request.url());
  });

  await page.goto(`${inspector.url}?run=${runId}`);
  await expect(page.locator('#timeline > li.node')).toHaveCount(CHECKPOINTS);
  await expect(page.locator('#timeline')).toHaveAttribute('data-ready', 'true');

  const timing = await page.evaluate(() => {
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    const rendered = performance.getEntriesByName('ckpt:timeline-rendered')[0];
    return { firstPaint: paint?.startTime ?? null, timelineRendered: rendered?.startTime ?? null };
  });
  expect(timing.firstPaint).not.toBeNull();
  expect(timing.timelineRendered).not.toBeNull();
  expect(timing.firstPaint ?? Number.POSITIVE_INFINITY).toBeLessThan(FIRST_PAINT_BUDGET_MS);
  expect(timing.timelineRendered ?? Number.POSITIVE_INFINITY).toBeLessThan(FIRST_PAINT_BUDGET_MS);

  // The page never leaves its own origin.
  expect(foreignRequests).toEqual([]);

  // Selecting a checkpoint shows the three panes and the copyable commands, without running them.
  await page.locator('#timeline > li.node').last().locator('button.open').click();
  await expect(page.locator('[data-pane="state"]')).toBeVisible();
  await expect(page.locator('[data-pane="workspace"]')).toBeVisible();
  await expect(page.locator('[data-pane="ledger"]')).toBeVisible();
  await expect(page.locator('.actions code')).toHaveText([
    `ckpt resume ${runId}:c_${CHECKPOINTS}`,
    `ckpt fork ${runId}:c_${CHECKPOINTS}`,
    `ckpt rollback ${runId}:c_${CHECKPOINTS}`,
    `ckpt export ${runId}:c_${CHECKPOINTS}`,
  ]);
});
