/**
 * `systemPreamble`: Tier 1 (state) and Tier 2 (workspace) rendered as plain text (SPEC-008).
 *
 * Deterministic: a pure function of its input, with no clock, locale or environment. Tier 3 is described, never
 * inlined, so the preamble does not depend on which events fit the budget. Pending intent follows the in-progress
 * rule and the Tier 1 bound in intents.ts.
 */
import type { NameStatus } from '../engine/types.js';
import type { AgentStateObject, Checkpoint, SemanticClaim, SemanticField } from '../model/types.js';
import { intentLine, renderedStatus, type Tier1Intents } from './intents.js';
import { printable } from './text.js';
import type { TargetAgent } from './types.js';

/** Tier 1 claim sections, in rendering order. */
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

export interface PreambleInput {
  readonly checkpoint: Checkpoint;
  readonly state: AgentStateObject;
  readonly ledgerCursor: number;
  /** The parent checkpoint record, or null for a run's first checkpoint. */
  readonly parent: Checkpoint | null;
  /** `git diff --name-status parent checkpoint`, or null when there is no parent. */
  readonly changes: readonly NameStatus[] | null;
  readonly intents: Tier1Intents;
  readonly claims: readonly SemanticClaim[];
  readonly workspacePath: string | null;
  readonly target: TargetAgent | null;
}

function claimLines(claim: SemanticClaim): string[] {
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

function omittedLine(status: 'completed' | 'pending', count: number): string {
  return status === 'completed'
    ? `  - ${count} earlier completed tool actions omitted: their workspace effects are in the commit below and the ledger keeps them`
    : `  - ${count} earlier failed tool actions omitted: the ledger keeps them`;
}

export function renderPreamble(input: PreambleInput): string {
  const { checkpoint, parent, changes, target, ledgerCursor } = input;
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

  lines.push('', '## Tier 1 — State');
  for (const [field, heading] of CLAIM_SECTIONS) {
    const claims = input.claims.filter((claim) => claim.field === field);
    lines.push(`${heading}:`);
    if (claims.length === 0) lines.push('  - none recorded');
    for (const claim of claims) lines.push(...claimLines(claim));
  }
  const { listed, omittedCompleted, omittedFailed } = input.intents;
  for (const status of ['completed', 'in_progress', 'pending'] as const) {
    const matching = listed.filter((intent) => renderedStatus(intent) === status);
    const omitted = status === 'completed' ? omittedCompleted : status === 'pending' ? omittedFailed : 0;
    lines.push(`${status}:`);
    if (matching.length === 0 && omitted === 0) lines.push('  - none');
    for (const intent of matching) lines.push(intentLine(intent, ledgerCursor));
    if (omitted > 0 && status !== 'in_progress') lines.push(omittedLine(status, omitted));
  }

  lines.push('', '## Tier 2 — Workspace', `workspace commit: ${checkpoint.workspace_commit}`);
  if (input.workspacePath !== null) lines.push(`workspace path: ${printable(input.workspacePath)}`);
  if (parent === null || changes === null) {
    lines.push('changed paths since parent: not listed (no parent checkpoint in this run)');
  } else {
    lines.push(`changed paths since parent ${parent.checkpoint_id} (${parent.workspace_commit}):`);
    if (changes.length === 0) lines.push('  - none');
    for (const change of changes) {
      const from = change.oldPath === undefined ? '' : `${printable(change.oldPath)} -> `;
      lines.push(`  - ${printable(change.status)} ${from}${printable(change.path)}`);
    }
  }

  lines.push(
    '',
    '## Tier 3 — Relevant history',
    'hydratedEvents holds selected ledger events at or before the ledger cursor, never the full transcript. ' +
      'Order: events cited by the claims above, then the last tool failure, then the most recent events since the parent checkpoint, newest first. ' +
      'A payload over 4 KB appears as payload_ref (sha256 of its canonical JSON) instead of inline.',
  );
  return lines.join('\n');
}
