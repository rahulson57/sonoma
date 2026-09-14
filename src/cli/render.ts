/**
 * Terminal rendering of module results. Rendering only: every value shown was returned by the module that owns it, and
 * those modules redact before persisting (SPEC-003), so nothing here reads, derives or unredacts data.
 */
import type { BundleScanReport } from '../bundle/index.js';
import type { ResumeContext } from '../context/index.js';
import type { DistillResult } from '../distill/index.js';
import type { CheckpointDiff, NameStatus, RestoredCheckpoint } from '../engine/index.js';
import type { Checkpoint, Run, SideEffect } from '../model/types.js';
import type { ReindexCounts } from '../storage/index.js';
import type { CheckpointPanes } from '../ui/index.js';

/** `--json`: exactly the module's return value. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function table(rows: readonly (readonly string[])[]): string {
  const columns = rows[0]?.length ?? 0;
  const widths = Array.from({ length: columns }, (_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)));
  const lines = rows.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
  return `${lines.join('\n')}\n`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function renderRuns(runs: readonly Run[]): string {
  if (runs.length === 0) return 'No runs.\n';
  return table([
    ['RUN', 'AGENT', 'CREATED', 'FORKED FROM'],
    ...runs.map((run) => [run.run_id, run.agent, run.created_at, run.parent_run_id === null ? '-' : `${run.parent_run_id}:${run.forked_from_checkpoint ?? '?'}`]),
  ]);
}

export function renderCheckpoints(runId: string, checkpoints: readonly Checkpoint[]): string {
  if (checkpoints.length === 0) return `No checkpoints in ${runId}.\n`;
  return table([
    ['CHECKPOINT', 'PARENT', 'LABEL', 'CREATED', 'LEDGER', 'COMMIT'],
    ...checkpoints.map((cp) => [
      `${cp.run_id}:${cp.checkpoint_id}`,
      cp.parent_checkpoint_id ?? '-',
      cp.label ?? '-',
      cp.created_at,
      String(cp.ledger_seq),
      cp.workspace_commit.slice(0, 12),
    ]),
  ]);
}

function sideEffectLine(effect: SideEffect): string {
  return `${effect.type} ${effect.target} (${effect.reversibility})`;
}

function indent(text: string, by = '  '): string[] {
  return text.split('\n').map((line) => `${by}${line}`);
}

export function renderPanes(id: string, panes: CheckpointPanes): string {
  const { state, workspace, ledger } = panes;
  return [
    `Checkpoint ${id}`,
    '',
    'STATE',
    ...indent(JSON.stringify(state, null, 2)),
    '',
    'WORKSPACE',
    `  commit        ${workspace.commit}`,
    `  changed       ${plural(workspace.changedPaths.length, 'path')}`,
    ...workspace.changedPaths.map((changed) => `    ${changed}`),
    '',
    'LEDGER',
    `  events        (${ledger.range[0]}, ${ledger.range[1]}]`,
    `  tools         ${ledger.toolsUsed.length === 0 ? '-' : ledger.toolsUsed.join(', ')}`,
    `  model calls   ${ledger.modelCalls}`,
    `  side effects  ${ledger.sideEffects.length}`,
    ...ledger.sideEffects.map((effect) => `    ${sideEffectLine(effect)}`),
    '',
  ].join('\n');
}

function nameStatusLine(entry: NameStatus): string {
  return entry.oldPath === undefined ? `  ${entry.status}  ${entry.path}` : `  ${entry.status}  ${entry.oldPath} -> ${entry.path}`;
}

export function renderDiff(a: string, b: string, diff: CheckpointDiff): string {
  return [
    `Diff ${a} .. ${b}`,
    '',
    `State (${plural(diff.state.length, 'change')})`,
    ...diff.state.map((op) => `  ${op.op} ${op.path}`),
    '',
    `Workspace (${plural(diff.workspace.length, 'file')})`,
    ...diff.workspace.map(nameStatusLine),
    '',
    'Ledger',
    `  a  (${diff.ledger.a[0]}, ${diff.ledger.a[1]}]`,
    `  b  (${diff.ledger.b[0]}, ${diff.ledger.b[1]}]`,
    '',
    `Side effects (${diff.sideEffects.length})`,
    ...diff.sideEffects.map((effect) => `  ${sideEffectLine(effect)}`),
    '',
  ].join('\n');
}

/** Summary for stderr; the context itself goes to stdout. */
export function renderResumeSummary(id: string, restored: RestoredCheckpoint, context: ResumeContext): string {
  return [
    `Resumed ${id} in ${restored.worktreePath}`,
    `  workspace commit  ${context.workspaceCommit}`,
    `  ledger cursor     ${restored.checkpoint.ledger_seq}`,
    `  pending intents   ${context.state.pending_intent.length}`,
    `  hydrated events   ${context.hydratedEvents.length}`,
    `  token estimate    ${context.tokenEstimate}`,
    '',
  ].join('\n');
}

/** One stderr line per side effect a rollback does not undo. */
export function renderRollbackWarning(effect: SideEffect): string {
  return `warning: side effect not undone by rollback: ${sideEffectLine(effect)}\n`;
}

export function renderScanReport(report: BundleScanReport, unsafe: boolean): string {
  const byKind = new Map<string, number>();
  for (const hit of report.hits) byKind.set(hit.kind, (byKind.get(hit.kind) ?? 0) + 1);
  const kinds = [...byKind].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([kind, n]) => `${kind}: ${n}`);
  const hits = report.hits.length;
  let outcome: string;
  if (unsafe) outcome = `--unsafe: redaction is bypassed; ${plural(hits, 'hit')} would be written unredacted.`;
  else if (hits > 0) outcome = `${plural(hits, 'redaction')} would be applied. A content-redacted bundle is NOT importable.`;
  else outcome = 'No redactions needed.';
  return [
    'Export scan report',
    `  files scanned  ${report.filesScanned}`,
    `  tool outputs   ${report.toolOutputs}`,
    `  env entries    ${report.envEntries}`,
    `  hits           ${hits}${kinds.length === 0 ? '' : `  (${kinds.join(', ')})`}`,
    `  redactions     ${unsafe ? 0 : hits}`,
    outcome,
    '',
  ].join('\n');
}

export function renderReindex(counts: ReindexCounts): string {
  return `Reindexed ${plural(counts.runs, 'run')}, ${plural(counts.checkpoints, 'checkpoint')}, ${plural(counts.events, 'event')}, ${plural(counts.projections, 'projection')}, ${plural(counts.claims, 'claim')}.\n`;
}

export function renderImport(runIds: readonly string[]): string {
  return [`Imported ${plural(runIds.length, 'run')}.`, ...runIds.map((runId) => `  ${runId}`), ''].join('\n');
}

export function renderDistill(id: string, result: DistillResult): string {
  const { projection, rejectedClaims, budget } = result;
  const usage = projection.usage;
  return [
    `Distilled ${id}: projection ${projection.id}`,
    `  claims          ${projection.claims.length} kept, ${rejectedClaims} rejected`,
    ...(usage === null ? [] : [`  usage           ${usage.inputTokens} input / ${usage.outputTokens} output tokens, $${usage.costUsd.toFixed(6)}`]),
    `  run budget      $${budget.spentUsd.toFixed(6)} of $${budget.capUsd.toFixed(2)} spent`,
    '',
  ].join('\n');
}
