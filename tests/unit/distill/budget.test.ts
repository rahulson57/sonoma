/** SPEC-007 "Budget": with spentUsd >= capUsd, distill() rejects with DISTILL_BUDGET_EXCEEDED before calling the provider. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_USD, createBudget, distill } from '../../../src/distill/index.js';
import { USAGE, depsFor, fakeRun, reply, spyProvider, untouchableSource } from './support.js';

const RUN = { events: 40, prevCursor: 10, cursor: 30 } as const;

describe('distill() budget', () => {
  it.each([
    { capUsd: 0.25, spentUsd: 0.25 },
    { capUsd: 0.25, spentUsd: 0.31 },
    { capUsd: 0, spentUsd: 0 },
  ])('rejects with DISTILL_BUDGET_EXCEEDED and never calls the provider when spentUsd $spentUsd >= capUsd $capUsd', async (amounts) => {
    const run = await fakeRun(RUN);
    const provider = spyProvider(reply([]));
    const deps = { ...depsFor(run, provider, { runId: run.runId, ...amounts }), source: untouchableSource(run.runId) };

    await expect(distill(run.request, deps)).rejects.toMatchObject({ name: 'DistillError', code: 'DISTILL_BUDGET_EXCEEDED' });
    expect(provider.prompts).toHaveLength(0);
  });

  it('calls the provider below the cap and charges its cost to the run', async () => {
    const run = await fakeRun(RUN);
    const provider = spyProvider(reply([]));

    const result = await distill(run.request, depsFor(run, provider, { runId: run.runId, capUsd: 0.25, spentUsd: 0.1 }));

    expect(provider.prompts).toHaveLength(1);
    expect(result.budget.runId).toBe(run.runId);
    expect(result.budget.capUsd).toBe(0.25);
    expect(result.budget.spentUsd).toBeCloseTo(0.1 + USAGE.costUsd, 10);
  });

  it('stops distilling a run once its spend reaches the cap', async () => {
    const run = await fakeRun(RUN);
    const provider = spyProvider(reply([]), { usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.002 } });
    const deps = depsFor(run, provider, createBudget(run.runId, 0.005));

    let budget = deps.budget;
    for (let i = 0; i < 3; i++) budget = (await distill(run.request, { ...deps, budget })).budget;

    expect(budget.spentUsd).toBeCloseTo(0.006, 10);
    await expect(distill(run.request, { ...deps, budget })).rejects.toMatchObject({ code: 'DISTILL_BUDGET_EXCEEDED' });
    expect(provider.prompts).toHaveLength(3);
  });

  it('defaults the cap to $0.25 per run', () => {
    expect(DEFAULT_BUDGET_USD).toBe(0.25);
    expect(createBudget('run_x')).toEqual({ runId: 'run_x', capUsd: 0.25, spentUsd: 0 });
  });

  it('rejects a malformed budget, or one for another run, before calling the provider', async () => {
    const run = await fakeRun(RUN);
    const provider = spyProvider(reply([]));

    await expect(distill(run.request, depsFor(run, provider, { runId: run.runId, capUsd: 0.25, spentUsd: Number.NaN }))).rejects.toMatchObject({
      code: 'DISTILL_INVALID_REQUEST',
    });
    await expect(distill(run.request, depsFor(run, provider, createBudget('run_other')))).rejects.toMatchObject({
      code: 'DISTILL_INVALID_REQUEST',
    });
    expect(provider.prompts).toHaveLength(0);
  });
});
