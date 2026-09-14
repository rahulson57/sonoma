/**
 * Context Builder — SPEC-008: rebuild a FRESH agent context from a restored checkpoint for resume and handoff.
 *
 * - Tier 1 (state) and Tier 2 (workspace commit + changed paths since the parent) are always included. Tier 1's
 *   pending intent is bounded so it does not grow with run length (intents.ts, Q-020): `state.pending_intent` in the
 *   result is narrowed to exactly the intents the preamble lists, every other member of the state is unchanged. When
 *   Tier 1 + Tier 2 still exceed maxTokens the build rejects with ERR_BUDGET instead of emitting an oversized context.
 * - Tier 3 candidates come from one backward walk of the checkpoint's lineage (history.ts), never past the cursor.
 *   They are added in priority order (provenance-cited, seq ascending → last tool failure → delta since the parent,
 *   newest first) until the first event that does not fit whole; that event and everything after it are dropped.
 * - Tier 4 (the full transcript) is never included.
 *
 * Must never: call an LLM or the Distiller, or write storage, the ledger or git. The dependencies it is given are
 * read-only by type (getEvents, getCheckpoint, diffNameStatus, claimsFor), and nothing here reads a clock, so the same
 * checkpoint and maxTokens give a byte-identical ResumeContext.
 */
import type { NameStatus } from '../engine/types.js';
import type { Checkpoint, LedgerEvent, PendingIntent, SemanticClaim } from '../model/types.js';
import { validateAgentState, validateCheckpoint, validateSemanticClaim } from '../model/validate.js';
import { hydrateEvent, normalizeJson, tokensForChars } from './budget.js';
import { ContextError } from './errors.js';
import { scanRelevantHistory } from './history.js';
import { TIER1_RESOLVED_SHARE, narrowStateIntents, selectTier1Intents } from './intents.js';
import { renderPreamble } from './preamble.js';
import { compareText } from './text.js';
import {
  CHARS_PER_TOKEN,
  DEFAULT_MAX_TOKENS,
  type ClaimSource,
  type ContextBuilder,
  type ContextBuilderDeps,
  type ContextStorage,
  type RestoredCheckpointInput,
  type ResumeContext,
  type TargetAgent,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): ContextError {
  return new ContextError('ERR_INVALID_INPUT', message);
}

function corrupt(message: string): ContextError {
  return new ContextError('ERR_CORRUPT', message);
}

interface CheckedInput {
  readonly checkpoint: Checkpoint;
  readonly state: RestoredCheckpointInput['state'];
  readonly ledgerCursor: number;
  readonly intents: readonly PendingIntent[];
  readonly workspacePath: string | null;
}

function checkInput(restored: unknown): CheckedInput {
  if (!isRecord(restored)) throw invalid('the restored checkpoint must be an object {checkpoint, state, ...}');
  const checkpointResult = validateCheckpoint(restored['checkpoint']);
  if (!checkpointResult.ok) throw invalid(`checkpoint: ${checkpointResult.errors.join('; ')}`);
  const stateResult = validateAgentState(restored['state']);
  if (!stateResult.ok) throw invalid(`state: ${stateResult.errors.join('; ')}`);
  const checkpoint = checkpointResult.value;
  const state = stateResult.value;

  const pairs = [
    ['run_id', state.run_id, checkpoint.run_id],
    ['checkpoint_id', state.checkpoint_id, checkpoint.checkpoint_id],
    ['ledger_seq', state.ledger_seq, checkpoint.ledger_seq],
    ['workspace_commit', state.workspace_commit, checkpoint.workspace_commit],
  ] as const;
  for (const [key, ofState, ofCheckpoint] of pairs) {
    if (ofState !== ofCheckpoint) throw invalid(`state.${key} does not match the checkpoint's ${key}`);
  }

  const ledgerCursor = restored['ledgerCursor'];
  if (ledgerCursor !== undefined && ledgerCursor !== checkpoint.ledger_seq) {
    throw invalid(`ledgerCursor must equal checkpoint.ledger_seq (${checkpoint.ledger_seq})`);
  }

  let intents: readonly PendingIntent[] = state.pending_intent;
  if (restored['pendingIntent'] !== undefined) {
    // The state validator is the schema for PendingIntent[]; the supplied list is what the preamble renders.
    const probe = validateAgentState({ ...state, pending_intent: restored['pendingIntent'] });
    if (!probe.ok) throw invalid(`pendingIntent: ${probe.errors.join('; ')}`);
    intents = probe.value.pending_intent;
  }

  const paths = [restored['workspacePath'], restored['worktreePath']].filter((value) => value !== undefined);
  for (const value of paths) {
    if (typeof value !== 'string' || value === '') throw invalid('workspacePath / worktreePath must be a non-empty string');
  }
  if (paths.length === 2 && paths[0] !== paths[1]) throw invalid('workspacePath and worktreePath name different directories');
  const workspacePath = typeof paths[0] === 'string' ? paths[0] : null;

  return { checkpoint, state, ledgerCursor: checkpoint.ledger_seq, intents, workspacePath };
}

function checkMaxTokens(options: unknown): number {
  if (options === undefined) return DEFAULT_MAX_TOKENS;
  if (!isRecord(options)) throw invalid('options must be an object {maxTokens?}');
  const maxTokens = options['maxTokens'];
  if (maxTokens === undefined) return DEFAULT_MAX_TOKENS;
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw invalid('maxTokens must be a positive integer');
  }
  return maxTokens;
}

function checkTarget(target: unknown): TargetAgent {
  if (!isRecord(target)) throw invalid('targetAgent must be an object {harness, model?}');
  const { harness, model } = target;
  if (typeof harness !== 'string' || harness === '') throw invalid('targetAgent.harness must be a non-empty string');
  if (model === undefined) return { harness };
  if (typeof model !== 'string' || model === '') throw invalid('targetAgent.model must be a non-empty string when given');
  return { harness, model };
}

async function loadClaims(source: ClaimSource | undefined, checkpoint: Checkpoint): Promise<SemanticClaim[]> {
  if (source === undefined) return [];
  const claims: unknown = await source.claimsFor(checkpoint);
  if (!Array.isArray(claims)) throw corrupt('the claim source did not return an array');
  return claims.map((claim, index) => {
    const result = validateSemanticClaim(claim);
    if (!result.ok) throw corrupt(`claim ${index}: ${result.errors.join('; ')}`);
    return result.value;
  });
}

async function loadParent(storage: ContextStorage, checkpoint: Checkpoint): Promise<Checkpoint | null> {
  const parentId = checkpoint.parent_checkpoint_id;
  if (parentId === null) return null;
  const result = validateCheckpoint(await storage.getCheckpoint({ run_id: checkpoint.run_id, checkpoint_id: parentId }));
  if (!result.ok) throw corrupt(`parent checkpoint ${parentId}: ${result.errors.join('; ')}`);
  const parent = result.value;
  if (parent.run_id !== checkpoint.run_id || parent.checkpoint_id !== parentId) {
    throw corrupt(`storage returned ${parent.run_id}:${parent.checkpoint_id} for parent ${checkpoint.run_id}:${parentId}`);
  }
  if (parent.ledger_seq >= checkpoint.ledger_seq) {
    throw corrupt(`parent ${parentId} cursor ${parent.ledger_seq} is not before ${checkpoint.checkpoint_id} cursor ${checkpoint.ledger_seq}`);
  }
  return parent;
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

async function build(deps: ContextBuilderDeps, restored: unknown, maxTokens: number, target: TargetAgent | null): Promise<ResumeContext> {
  const input = checkInput(restored);
  const { checkpoint, ledgerCursor } = input;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const claims = await loadClaims(deps.claims, checkpoint);
  const parent = await loadParent(deps.storage, checkpoint);
  const changes = parent === null ? null : sortedChanges(await deps.git.diffNameStatus(parent.workspace_commit, checkpoint.workspace_commit));

  const intents = selectTier1Intents(input.intents, ledgerCursor, Math.floor(maxChars * TIER1_RESOLVED_SHARE));
  const systemPreamble = renderPreamble({
    checkpoint,
    state: input.state,
    ledgerCursor,
    parent,
    changes,
    intents,
    claims,
    workspacePath: input.workspacePath,
    target,
  });
  const state = normalizeJson({ ...input.state, pending_intent: narrowStateIntents(input.state.pending_intent, intents) }, 'state');
  const workspaceCommit = checkpoint.workspace_commit;

  const baseChars = JSON.stringify({ systemPreamble, state, workspaceCommit, hydratedEvents: [] }).length;
  if (baseChars > maxChars) {
    throw new ContextError('ERR_BUDGET', `Tier 1 and Tier 2 alone need ${tokensForChars(baseChars)} tokens; maxTokens is ${maxTokens}`);
  }

  const views = new Map<LedgerEvent, { readonly event: LedgerEvent; readonly chars: number }>();
  const view = (event: LedgerEvent): { readonly event: LedgerEvent; readonly chars: number } => {
    let entry = views.get(event);
    if (entry === undefined) {
      const hydrated = hydrateEvent(event);
      entry = { event: hydrated, chars: JSON.stringify(hydrated).length };
      views.set(event, entry);
    }
    return entry;
  };

  const history = await scanRelevantHistory(deps.storage, {
    runId: checkpoint.run_id,
    ledgerCursor,
    parentCursor: parent?.ledger_seq ?? 0,
    citedEventIds: new Set(claims.flatMap((claim) => claim.provenance.event_ids)),
    deltaCharLimit: maxChars - baseChars,
    charsOf: (event) => view(event).chars,
  });

  const candidates = [...history.cited, ...(history.lastFailure === null ? [] : [history.lastFailure]), ...history.delta];
  const hydratedEvents: LedgerEvent[] = [];
  const included = new Set<string>();
  let chars = baseChars;
  for (const candidate of candidates) {
    if (included.has(candidate.event_id)) continue;
    const entry = view(candidate);
    const next = chars + entry.chars + (hydratedEvents.length > 0 ? 1 : 0);
    if (next > maxChars) break;
    hydratedEvents.push(entry.event);
    included.add(candidate.event_id);
    chars = next;
  }

  return { systemPreamble, state, workspaceCommit, hydratedEvents, tokenEstimate: tokensForChars(chars) };
}

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  if (!isRecord(deps)) throw invalid('createContextBuilder needs {storage, git, claims?}');
  const { storage, git, claims } = deps;
  if (!isRecord(storage) || typeof storage['getEvents'] !== 'function' || typeof storage['getCheckpoint'] !== 'function') {
    throw invalid('deps.storage must provide getEvents and getCheckpoint');
  }
  if (!isRecord(git) || typeof git['diffNameStatus'] !== 'function') throw invalid('deps.git must provide diffNameStatus');
  if (claims !== undefined && (!isRecord(claims) || typeof claims['claimsFor'] !== 'function')) {
    throw invalid('deps.claims must provide claimsFor');
  }
  return {
    buildResumeContext: async (restored, options) => build(deps, restored, checkMaxTokens(options), null),
    // Handoff builds at the default budget and names the target. It never distills: that trigger belongs to the CLI.
    buildHandoffContext: async (restored, targetAgent) => build(deps, restored, DEFAULT_MAX_TOKENS, checkTarget(targetAgent)),
  };
}
