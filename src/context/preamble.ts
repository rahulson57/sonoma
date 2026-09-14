/**
 * `systemPreamble`: Tier 1 (state) and Tier 2 (workspace) rendered as plain text (SPEC-008).
 *
 * Deterministic: a pure function of its input, with no clock, locale or environment. Tier 3 is described, never
 * inlined, so the preamble does not depend on which events fit the budget. Which Tier 1 items appear, and the exact
 * omitted counts (DEC-034(4)), come from tier1.ts, which measures the line builders exported here.
 */
import type { NameStatus } from '../engine/types.js';
import type { AgentStateObject, Checkpoint, SemanticClaim, SemanticField } from '../model/types.js';
import { COMPLETED_TOOL_INTENT_CAP, PENDING_TOOL_INTENT_CAP, compareIntents, intentLine, renderedStatus } from './intents.js';
import { printable } from './text.js';
import type { Tier1Selection } from './tier1.js';
import type { TargetAgent } from './types.js';

/** Tier 1 claim sections, in rendering order. SPEC-008's `constraints` has no source and is dropped (DEC-036(1)). */
export const CLAIM_SECTIONS: ReadonlyArray<readonly [field: SemanticField, heading: string]> = [
  ['goal', 'goal'],
  ['plan', 'plan'],
  ['current_step', 'current_step'],
  ['current_state', 'current_state'],
  ['decision', 'decisions'],
  ['assumption', 'assumptions'],
  ['open_question', 'open_questions'],
  ['next_action', 'next_action'],
];

/** DEC-036(1): what the preamble says when no checkpoint on the lineage has claims. */
export const NO_SEMANTIC_STATE = 'no semantic state recorded';

/** What the Tier 2 changed paths are measured from. */
export interface WorkspaceBase {
  /** `parent`: the parent checkpoint in the same run. `fork`: the checkpoint a forked run's first checkpoint started from. */
  readonly kind: 'parent' | 'fork';
  readonly checkpoint: Checkpoint;
}

export interface PreambleInput {
  readonly checkpoint: Checkpoint;
  readonly state: AgentStateObject;
  readonly ledgerCursor: number;
  /** null for the first checkpoint of a run that was not forked. */
  readonly base: WorkspaceBase | null;
  /** `git diff --name-status base checkpoint`, or null when there is no base. */
  readonly changes: readonly NameStatus[] | null;
  /** The checkpoint the claims come from, or null when there are none. */
  readonly claimSource: Checkpoint | null;
  readonly tier1: Tier1Selection;
  /** Tier 3 candidates dropped for size, or null before Tier 3 is selected (the widest line is rendered instead). */
  readonly tier3Dropped: Tier3DroppedCounts | null;
  readonly workspacePath: string | null;
  readonly target: TargetAgent | null;
}

export function claimLines(claim: SemanticClaim): string[] {
  const { event_ids, artifact_refs, workspace_paths, checkpoint_ids } = claim.provenance;
  const evidence = [
    ...event_ids.map((id) => `event ${printable(id)}`),
    ...artifact_refs.map((ref) => `artifact ${printable(ref)}`),
    ...workspace_paths.map((p) => `path ${printable(p)}`),
    ...checkpoint_ids.map((id) => `checkpoint ${printable(id)}`),
  ].join(', ');
  const confidence = claim.confidence === undefined ? '' : `; confidence ${claim.confidence}`;
  return [`  - ${claim.value.split(/\r\n|\r|\n/).join('\n    ')}`, `    (origin ${claim.origin}${confidence}; evidence: ${evidence})`];
}

/** The line counting a section's left-out claims, or null when none are left out. */
export function omittedClaimsLine(count: number): string | null {
  return count > 0 ? `  - ${count} more claims omitted: they do not fit the token budget` : null;
}

/** The line counting a bounded group's left-out tool intents, or null when none are left out. */
export function omittedIntentsLine(group: 'pending' | 'completed', count: number): string | null {
  if (count <= 0) return null;
  return group === 'completed'
    ? `  - ${count} completed tool actions omitted (at most the newest ${COMPLETED_TOOL_INTENT_CAP} that fit the token budget are listed): their workspace effects are in the commit below and the ledger keeps them`
    : `  - ${count} failed tool actions omitted (at most the newest ${PENDING_TOOL_INTENT_CAP} that fit the token budget are listed): the ledger keeps them`;
}

/** Tier 3 candidates dropped because they did not fit whole, per category. Each event is counted once, at its highest priority. */
export interface Tier3DroppedCounts {
  readonly cited: number;
  readonly lastFailure: number;
  readonly delta: number;
}

export function tier3DroppedLine(counts: Tier3DroppedCounts): string {
  return `left out because they do not fit whole: cited ${counts.cited}, last failure ${counts.lastFailure}, delta ${counts.delta}`;
}

/**
 * The widest tier3DroppedLine can be for this cursor. It is rendered while Tier 1 and the Tier 3 budget are measured, so
 * the room for the real counts is reserved: no count can exceed the number of events at or before the cursor, so no
 * count has more digits than the cursor.
 */
export function reservedTier3DroppedLine(ledgerCursor: number): string {
  const widest = Number('9'.repeat(String(ledgerCursor).length));
  return tier3DroppedLine({ cited: widest, lastFailure: widest, delta: widest });
}

function sourceLines(checkpoint: Checkpoint, source: Checkpoint | null): string[] {
  if (source === null) return [`semantic state source: none (${NO_SEMANTIC_STATE} on this checkpoint's lineage)`];
  if (source.run_id === checkpoint.run_id && source.checkpoint_id === checkpoint.checkpoint_id) {
    return [`semantic state source: this checkpoint (${source.run_id}:${source.checkpoint_id})`];
  }
  const lines = [
    `semantic state source: checkpoint ${source.run_id}:${source.checkpoint_id} (ledger cursor seq ${source.ledger_seq}), ` +
      'the nearest earlier checkpoint on this lineage with recorded claims. The claims below describe that checkpoint: verify them against this one.',
  ];
  if (source.run_id !== checkpoint.run_id) {
    lines.push(`That checkpoint is in run ${source.run_id}, which this run descends from by fork; the ledger events its claims cite are not hydrated here.`);
  }
  return lines;
}

function pushLine(lines: string[], line: string | null): void {
  if (line !== null) lines.push(line);
}

export function renderPreamble(input: PreambleInput): string {
  const { checkpoint, base, changes, target, ledgerCursor, tier1 } = input;
  const lines: string[] = [
    '# ckpt resume context',
    `Fresh context rebuilt from checkpoint ${checkpoint.run_id}:${checkpoint.checkpoint_id}. The original transcript is not replayed. ` +
      'Anything not shown here is unknown: verify it against the workspace before relying on it.',
  ];

  if (target !== null) {
    lines.push('', '## Handoff', `target harness: ${printable(target.harness)}`, `target model: ${target.model === undefined ? 'unspecified' : printable(target.model)}`);
  }

  lines.push(
    '',
    '## Checkpoint',
    `run: ${checkpoint.run_id}`,
    `checkpoint: ${checkpoint.checkpoint_id}`,
    `label: ${checkpoint.label === null ? 'none' : printable(checkpoint.label)}`,
    `parent checkpoint: ${checkpoint.parent_checkpoint_id ?? 'none'}`,
    `ledger cursor: seq ${ledgerCursor}`,
    `usage: input_tokens=${input.state.usage.input_tokens} output_tokens=${input.state.usage.output_tokens}`,
  );

  lines.push('', '## Tier 1 — State', ...sourceLines(checkpoint, input.claimSource));
  for (const [field, heading] of CLAIM_SECTIONS) {
    const claims = tier1.claims.filter((claim) => claim.field === field);
    const omitted = tier1.omittedClaims.get(field) ?? 0;
    lines.push(`${heading}:`);
    if (claims.length === 0 && omitted === 0) lines.push('  - none recorded');
    for (const claim of claims) lines.push(...claimLines(claim));
    pushLine(lines, omittedClaimsLine(omitted));
  }
  const omittedTools = { completed: tier1.omittedCompletedTools, in_progress: 0, pending: tier1.omittedPendingTools };
  for (const status of ['completed', 'in_progress', 'pending'] as const) {
    const matching = tier1.intents.filter((intent) => renderedStatus(intent) === status).sort(compareIntents);
    const omitted = omittedTools[status];
    lines.push(`${status}:`);
    if (matching.length === 0 && omitted === 0) lines.push('  - none');
    for (const intent of matching) lines.push(intentLine(intent, ledgerCursor));
    if (status !== 'in_progress') pushLine(lines, omittedIntentsLine(status, omitted));
  }

  lines.push('', '## Tier 2 — Workspace', `workspace commit: ${checkpoint.workspace_commit}`);
  if (input.workspacePath !== null) lines.push(`workspace path: ${printable(input.workspacePath)}`);
  if (base === null || changes === null) {
    lines.push('changed paths since parent: not listed (no parent checkpoint in this run)');
  } else {
    const from = base.checkpoint;
    lines.push(
      base.kind === 'parent'
        ? `changed paths since parent ${from.checkpoint_id} (${from.workspace_commit}):`
        : `changed paths since fork source ${from.run_id}:${from.checkpoint_id} (${from.workspace_commit}):`,
    );
    if (changes.length === 0) lines.push('  - none');
    for (const change of changes) {
      const renamedFrom = change.oldPath === undefined ? '' : `${printable(change.oldPath)} -> `;
      lines.push(`  - ${printable(change.status)} ${renamedFrom}${printable(change.path)}`);
    }
  }

  lines.push(
    '',
    '## Tier 3 — Relevant history',
    "hydratedEvents holds selected ledger events at or before the ledger cursor on this checkpoint's own lineage, never the full transcript. " +
      'Candidates, in priority order: events cited by the claims above, then the last tool failure, then the most recent events since the parent checkpoint, newest first (about one token budget of them). ' +
      'Each event is considered once, at its highest priority; one that does not fit the token budget whole is left out whole and the next is tried. ' +
      'An event whose payload is stored as a blob has payload null and keeps its payload_ref (sha256); every other payload is shown in full.',
    input.tier3Dropped === null ? reservedTier3DroppedLine(ledgerCursor) : tier3DroppedLine(input.tier3Dropped),
  );
  return lines.join('\n');
}
