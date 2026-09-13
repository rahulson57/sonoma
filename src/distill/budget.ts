/** SPEC-007 "Budget": a per-run cap on distillation spend, checked before the provider is called. */
import { DistillError } from './errors.js';
import { DEFAULT_BUDGET_USD, type DistillBudget, type ProviderUsage } from './types.js';

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function createBudget(runId: string, capUsd: number = DEFAULT_BUDGET_USD): DistillBudget {
  const budget = { runId, capUsd, spentUsd: 0 };
  assertBudgetShape(budget);
  return budget;
}

function assertBudgetShape(budget: DistillBudget): void {
  if (
    typeof budget !== 'object' ||
    budget === null ||
    typeof budget.runId !== 'string' ||
    budget.runId === '' ||
    !isAmount(budget.capUsd) ||
    !isAmount(budget.spentUsd)
  ) {
    throw new DistillError('DISTILL_INVALID_REQUEST', 'a DistillBudget is {runId, capUsd, spentUsd} with finite, non-negative amounts');
  }
}

/** Throws DISTILL_BUDGET_EXCEEDED when the run has already spent its cap (spentUsd >= capUsd). */
export function assertBudgetAvailable(budget: DistillBudget): void {
  assertBudgetShape(budget);
  if (budget.spentUsd >= budget.capUsd) {
    throw new DistillError(
      'DISTILL_BUDGET_EXCEEDED',
      `run ${budget.runId} has spent $${budget.spentUsd} of its $${budget.capUsd} distillation budget`,
    );
  }
}

/** The budget after a distillation that cost `usage.costUsd`. Pure: the input is not changed. */
export function chargeBudget(budget: DistillBudget, usage: ProviderUsage): DistillBudget {
  return { runId: budget.runId, capUsd: budget.capUsd, spentUsd: budget.spentUsd + usage.costUsd };
}
