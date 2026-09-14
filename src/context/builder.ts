/**
 * Context Builder — SPEC-008: rebuild a FRESH agent context from a restored checkpoint for resume and handoff, built
 * to the interim rulings DEC-034, DEC-036 and DEC-040, and the Tier 3 skip-and-continue decision (Q-022).
 *
 * 1. Validate the input (DEC-036(2)): checkpoint, state and the optional engine pendingIntent, against the S03
 *    validators. The rendered pending-intent list is pendingIntent when supplied, else state.pending_intent.
 * 2. Claims (DEC-036(1)): the nearest checkpoint on the lineage with any claims (claims.ts).
 * 3. Tier 2: the checkpoint commit, and the paths changed since the parent (or, for a forked run's first checkpoint,
 *    since the fork source).
 * 4. Tier 1 under the budget (tier1.ts): the mandatory set, then other claims, then bounded tool intents, each whole.
 *    `state.pending_intent` is exactly the intents the preamble lists (DEC-034(3)). The preamble is measured with room
 *    reserved for the widest Tier 3 counts line. ERR_BUDGET only when the mandatory context alone exceeds maxTokens
 *    (DEC-034(5)).
 * 5. Tier 3 (history.ts): candidates from one backward walk of the lineage, never past the cursor, outside abandoned
 *    windows (DEC-036(5)), in priority order: provenance-cited → last tool failure → delta since the parent, newest
 *    first. Each event is considered once, at its highest priority. One that does not fit whole is dropped whole and
 *    counted, and the next candidate is tried (SPEC-008 "An event that does not fit whole is dropped"; Q-022).
 * 6. The preamble's Tier 3 counts replace the reserved line, which is at least as wide, and
 *    tokenEstimate = ceil(canonicalJSON({systemPreamble, state, workspaceCommit, hydratedEvents}).length / 4).
 *
 * Tier 4 (the full transcript) is never included. Must never: call an LLM or the Distiller, or write storage, the
 * ledger or git. The dependencies it is given are read-only by type (getEvents, getCheckpoint, diffNameStatus,
 * claimsAt), and nothing here reads a clock, so the same checkpoint and maxTokens give a byte-identical ResumeContext.
 */
import type { NameStatus } from '../engine/types.js';
import type { AgentStateObject, Checkpoint, LedgerEvent, PendingIntent } from '../model/types.js';
import { validateAgentState, validateCheckpoint } from '../model/validate.js';
import { canonicalChars, contextChars, hydrateEvent, jsonTextChars, normalizeJson, tokensForChars } from './budget.js';
import { selectClaims } from './claims.js';
import { ContextError, corrupt, invalidInput } from './errors.js';
import { isRecord } from './guards.js';
import { scanRelevantHistory } from './history.js';
import { LineageReader } from './lineage.js';
import { renderPreamble, type Tier3DroppedCounts, type WorkspaceBase } from './preamble.js';
import { compareText } from './text.js';
import { mandatoryTier1, selectTier1, type Tier1Selection } from './tier1.js';
import {
  CHARS_PER_TOKEN,
  DEFAULT_MAX_TOKENS,
  type ContextBuilder,
  type ContextBuilderDeps,
  type RestoredCheckpointInput,
  type ResumeContext,
  type TargetAgent,
} from './types.js';

interface CheckedInput {
  readonly checkpoint: Checkpoint;
  readonly state: AgentStateObject;
  readonly ledgerCursor: number;
  /** The rendered pending-intent list: the engine's pendingIntent, else state.pending_intent. */
  readonly intents: readonly PendingIntent[];
  readonly workspacePath: string | null;
}

function checkInput(restored: unknown): CheckedInput {
  if (!isRecord(restored)) throw invalidInput('the restored checkpoint must be an object {checkpoint, state, ...}');
  const checkpointResult = validateCheckpoint(restored['checkpoint']);
  if (!checkpointResult.ok) throw invalidInput(`checkpoint: ${checkpointResult.errors.join('; ')}`);
  const stateResult = validateAgentState(restored['state']);
  if (!stateResult.ok) throw invalidInput(`state: ${stateResult.errors.join('; ')}`);
  const checkpoint = checkpointResult.value;
  const state = stateResult.value;

  const pairs = [
    ['run_id', state.run_id, checkpoint.run_id],
    ['checkpoint_id', state.checkpoint_id, checkpoint.checkpoint_id],
    ['ledger_seq', state.ledger_seq, checkpoint.ledger_seq],
    ['workspace_commit', state.workspace_commit, checkpoint.workspace_commit],
  ] as const;
  for (const [key, ofState, ofCheckpoint] of pairs) {
    if (ofState !== ofCheckpoint) throw invalidInput(`state.${key} does not match the checkpoint's ${key}`);
  }

  const ledgerCursor = restored['ledgerCursor'];
  if (ledgerCursor !== undefined && ledgerCursor !== checkpoint.ledger_seq) {
    throw invalidInput(`ledgerCursor must equal checkpoint.ledger_seq (${checkpoint.ledger_seq})`);
  }

  let intents: readonly PendingIntent[] = state.pending_intent;
  if (restored['pendingIntent'] !== undefined) {
    // The state validator is the schema for PendingIntent[]; the supplied list is what the preamble renders.
    const probe = validateAgentState({ ...state, pending_intent: restored['pendingIntent'] });
    if (!probe.ok) throw invalidInput(`pendingIntent: ${probe.errors.join('; ')}`);
    intents = probe.value.pending_intent;
  }

  const paths = [restored['workspacePath'], restored['worktreePath']].filter((value) => value !== undefined);
  for (const value of paths) {
    if (typeof value !== 'string' || value === '') throw invalidInput('workspacePath / worktreePath must be a non-empty string');
  }
  if (paths.length === 2 && paths[0] !== paths[1]) throw invalidInput('workspacePath and worktreePath name different directories');
  const workspacePath = typeof paths[0] === 'string' ? paths[0] : null;

  return { checkpoint, state, ledgerCursor: checkpoint.ledger_seq, intents, workspacePath };
}

function checkMaxTokens(options: unknown): number {
  if (options === undefined) return DEFAULT_MAX_TOKENS;
  if (!isRecord(options)) throw invalidInput('options must be an object {maxTokens?}');
  const maxTokens = options['maxTokens'];
  if (maxTokens === undefined) return DEFAULT_MAX_TOKENS;
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw invalidInput('maxTokens must be a positive integer');
  }
  return maxTokens;
}

function checkTarget(target: unknown): TargetAgent {
  if (!isRecord(target)) throw invalidInput('targetAgent must be an object {harness, model?}');
  const { harness, model } = target;
  if (typeof harness !== 'string' || harness === '') throw invalidInput('targetAgent.harness must be a non-empty string');
  if (model === undefined) return { harness };
  if (typeof model !== 'string' || model === '') throw invalidInput('targetAgent.model must be a non-empty string when given');
  return { harness, model };
}

function sortedChanges(changes: unknown): NameStatus[] {
  if (!Array.isArray(changes)) throw corrupt('the workspace diff did not return an array');
  return changes
    .map((change): NameStatus => {
      if (!isRecord(change) || typeof change['status'] !== 'string' || typeof change['path'] !== 'string') {
        throw corrupt('the workspace diff returned an entry without a status and path');
      }
      const { status, path, oldPath } = change;
      if (oldPath === undefined) return { status, path };
      if (typeof oldPath !== 'string') throw corrupt('the workspace diff returned a non-string oldPath');
      return { status, path, oldPath };
    })
    .sort((a, b) => compareText(a.path, b.path) || compareText(a.oldPath ?? '', b.oldPath ?? '') || compareText(a.status, b.status));
}

type Tier3Category = keyof Tier3DroppedCounts;

async function build(deps: ContextBuilderDeps, restored: unknown, maxTokens: number, target: TargetAgent | null): Promise<ResumeContext> {
  const input = checkInput(restored);
  const { checkpoint, ledgerCursor } = input;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const lineage = new LineageReader(deps.storage);

  const claims = await selectClaims(deps.claims, lineage, checkpoint);
  const parent = await lineage.parentOf(checkpoint);
  const forkSource = parent === null ? await lineage.forkOriginOf(checkpoint) : null;
  const base: WorkspaceBase | null =
    parent !== null ? { kind: 'parent', checkpoint: parent } : forkSource !== null ? { kind: 'fork', checkpoint: forkSource } : null;
  const changes = base === null ? null : sortedChanges(await deps.git.diffNameStatus(base.checkpoint.workspace_commit, checkpoint.workspace_commit));
  const workspaceCommit = checkpoint.workspace_commit;

  const preambleFor = (tier1: Tier1Selection, tier3Dropped: Tier3DroppedCounts | null): string =>
    renderPreamble({
      checkpoint,
      state: input.state,
      ledgerCursor,
      base,
      changes,
      claimSource: claims.source,
      tier1,
      tier3Dropped,
      workspacePath: input.workspacePath,
      target,
    });
  // DEC-034(3): the restored state, pending_intent replaced by the retained intents in the rendered list's order.
  const stateFor = (tier1: Tier1Selection): AgentStateObject => normalizeJson({ ...input.state, pending_intent: tier1.intents }, 'state');

  // Tier 1 + Tier 2, with the widest Tier 3 counts line reserved: the smallest valid context first, then the optional
  // Tier 1 items in priority order.
  const mandatory = mandatoryTier1(claims.claims, input.intents);
  const minimalChars = contextChars({ systemPreamble: preambleFor(mandatory, null), state: stateFor(mandatory), workspaceCommit, hydratedEvents: [] });
  const { selection, addedChars } = selectTier1(claims.claims, input.intents, ledgerCursor, maxChars - minimalChars);
  const reservedPreamble = preambleFor(selection, null);
  const state = stateFor(selection);
  const baseChars = contextChars({ systemPreamble: reservedPreamble, state, workspaceCommit, hydratedEvents: [] });
  if (baseChars !== minimalChars + addedChars) {
    throw new Error(`Context Builder: Tier 1 measured ${baseChars} characters but was selected as ${minimalChars + addedChars}`);
  }
  if (baseChars > maxChars) {
    throw new ContextError(
      'ERR_BUDGET',
      `the never-dropped Tier 1 set, Tier 2 and the mandatory preamble need ${tokensForChars(baseChars)} tokens; maxTokens is ${maxTokens}`,
    );
  }

  // Tier 3.
  const views = new Map<LedgerEvent, { readonly event: LedgerEvent; readonly chars: number }>();
  const view = (event: LedgerEvent): { readonly event: LedgerEvent; readonly chars: number } => {
    let entry = views.get(event);
    if (entry === undefined) {
      const hydrated = hydrateEvent(event);
      entry = { event: hydrated, chars: canonicalChars(hydrated, `ledger event seq ${String(event.seq)}`) };
      views.set(event, entry);
    }
    return entry;
  };

  // Claims from another run (across a fork) cite events in that run's ledger, which this build does not read.
  const citedEventIds = new Set(claims.source?.run_id === checkpoint.run_id ? selection.claims.flatMap((claim) => claim.provenance.event_ids) : []);
  const history = await scanRelevantHistory(deps.storage, {
    runId: checkpoint.run_id,
    ledgerCursor,
    parentCursor: parent?.ledger_seq ?? 0,
    citedEventIds,
    deltaCharLimit: maxChars - baseChars,
    charsOf: (event) => view(event).chars,
  });

  const hydratedEvents: LedgerEvent[] = [];
  const considered = new Set<string>();
  const dropped: Record<Tier3Category, number> = { cited: 0, lastFailure: 0, delta: history.oversizedDelta };
  let chars = baseChars;
  const consider = (event: LedgerEvent, category: Tier3Category): void => {
    // Once, at its highest priority.
    if (considered.has(event.event_id)) return;
    considered.add(event.event_id);
    const entry = view(event);
    const next = chars + entry.chars + (hydratedEvents.length > 0 ? 1 : 0);
    if (next > maxChars) {
      // Dropped whole; the next candidate may still fit.
      dropped[category] += 1;
      return;
    }
    hydratedEvents.push(entry.event);
    chars = next;
  };
  for (const event of history.cited) consider(event, 'cited');
  if (history.lastFailure !== null) consider(history.lastFailure, 'lastFailure');
  for (const event of history.delta) consider(event, 'delta');

  // The real counts replace the reserved line, which is at least as wide.
  const systemPreamble = preambleFor(selection, dropped);
  const finalChars = contextChars({ systemPreamble, state, workspaceCommit, hydratedEvents });
  const assembled = chars - jsonTextChars(reservedPreamble) + jsonTextChars(systemPreamble);
  if (finalChars !== assembled || finalChars > maxChars) {
    throw new Error(`Context Builder: the context measured ${finalChars} characters but was assembled as ${assembled} (limit ${maxChars})`);
  }
  return { systemPreamble, state, workspaceCommit, hydratedEvents, tokenEstimate: tokensForChars(finalChars) };
}

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  if (!isRecord(deps)) throw invalidInput('createContextBuilder needs {storage, git, claims?}');
  const { storage, git, claims } = deps;
  if (!isRecord(storage) || typeof storage['getEvents'] !== 'function' || typeof storage['getCheckpoint'] !== 'function') {
    throw invalidInput('deps.storage must provide getEvents and getCheckpoint');
  }
  if (!isRecord(git) || typeof git['diffNameStatus'] !== 'function') throw invalidInput('deps.git must provide diffNameStatus');
  if (claims !== undefined && (!isRecord(claims) || typeof claims['claimsAt'] !== 'function')) {
    throw invalidInput('deps.claims must provide claimsAt');
  }
  return {
    buildResumeContext: async (restored, options) => build(deps, restored, checkMaxTokens(options), null),
    // Handoff builds at the default budget and names the target. It never distills: that trigger belongs to the CLI.
    buildHandoffContext: async (restored, targetAgent) => build(deps, restored, DEFAULT_MAX_TOKENS, checkTarget(targetAgent)),
  };
}
