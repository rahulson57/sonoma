/**
 * Tier 1 under the token budget (DEC-034, DEC-036(1)).
 *
 * Priority, highest first:
 * 1. Mandatory, never dropped: every in-progress intent, every side-effect intent, and the goal, current_step and
 *    next_action claims. With Tier 2 and the rest of the preamble (headings, the claim source, the omitted counts)
 *    this is the smallest valid context. The builder raises ERR_BUDGET only when that alone exceeds maxTokens.
 * 2. Every other claim, in claim order, each whole.
 * 3. Failed tool intents (status pending), then completed tool intents: newest first by requested_seq, at most
 *    PENDING_TOOL_INTENT_CAP / COMPLETED_TOOL_INTENT_CAP per group.
 * Tier 3 comes after all of them (builder.ts).
 *
 * An optional item is added only if it fits whole; one that does not is left out and the next one is tried. Its size
 * is exact, in characters of the context's canonical JSON: its preamble lines, its state.pending_intent entry (for an
 * intent), and the change it makes to its section's omitted-count line. The sections that hold optional items start
 * with a non-zero omitted count, so no "none" placeholder line appears or disappears while items are added. The
 * builder re-measures the rendered context against these sizes.
 */
import type { PendingIntent, SemanticClaim, SemanticField } from '../model/types.js';
import { canonicalChars, preambleLinesChars } from './budget.js';
import { COMPLETED_TOOL_INTENT_CAP, PENDING_TOOL_INTENT_CAP, intentGroup, intentLine } from './intents.js';
import { claimLines, omittedClaimsLine, omittedIntentsLine } from './preamble.js';

/** DEC-036(1): claims of these fields are never dropped. */
export const MANDATORY_CLAIM_FIELDS: ReadonlySet<SemanticField> = new Set<SemanticField>(['goal', 'current_step', 'next_action']);

export interface Tier1Selection {
  /** Retained claims, in claim order. */
  readonly claims: readonly SemanticClaim[];
  /** Claims left out, per field. */
  readonly omittedClaims: ReadonlyMap<SemanticField, number>;
  /** Retained intents, in the rendered list's order. This is state.pending_intent (DEC-034(3)). */
  readonly intents: readonly PendingIntent[];
  /** Failed (status pending) tool intents left out. */
  readonly omittedPendingTools: number;
  /** Completed tool intents left out. */
  readonly omittedCompletedTools: number;
}

export interface Tier1Result {
  readonly selection: Tier1Selection;
  /** Characters the optional items add to the mandatory selection's context. Can be negative. */
  readonly addedChars: number;
}

interface Indexed {
  readonly index: number;
  readonly intent: PendingIntent;
}

function optionalLineChars(line: string | null): number {
  return line === null ? 0 : preambleLinesChars([line]);
}

function selectionOf(
  claims: readonly SemanticClaim[],
  keptClaims: ReadonlySet<number>,
  intents: readonly PendingIntent[],
  keptIntents: ReadonlySet<number>,
): Tier1Selection {
  const omittedClaims = new Map<SemanticField, number>();
  claims.forEach((claim, index) => {
    if (!keptClaims.has(index)) omittedClaims.set(claim.field, (omittedClaims.get(claim.field) ?? 0) + 1);
  });
  let omittedPendingTools = 0;
  let omittedCompletedTools = 0;
  intents.forEach((intent, index) => {
    if (keptIntents.has(index)) return;
    const group = intentGroup(intent);
    if (group === 'pending') omittedPendingTools += 1;
    else if (group === 'completed') omittedCompletedTools += 1;
  });
  return {
    claims: claims.filter((_, index) => keptClaims.has(index)),
    omittedClaims,
    intents: intents.filter((_, index) => keptIntents.has(index)),
    omittedPendingTools,
    omittedCompletedTools,
  };
}

function mandatoryIndexes(claims: readonly SemanticClaim[], intents: readonly PendingIntent[]): { claims: Set<number>; intents: Set<number> } {
  const keptClaims = new Set<number>();
  claims.forEach((claim, index) => {
    if (MANDATORY_CLAIM_FIELDS.has(claim.field)) keptClaims.add(index);
  });
  const keptIntents = new Set<number>();
  intents.forEach((intent, index) => {
    if (intentGroup(intent) === 'never_dropped') keptIntents.add(index);
  });
  return { claims: keptClaims, intents: keptIntents };
}

/** The mandatory items only, every optional item counted as omitted: the smallest valid Tier 1. */
export function mandatoryTier1(claims: readonly SemanticClaim[], intents: readonly PendingIntent[]): Tier1Selection {
  const kept = mandatoryIndexes(claims, intents);
  return selectionOf(claims, kept.claims, intents, kept.intents);
}

/** The mandatory items plus every optional item, in priority order, that fits whole within `roomChars`. */
export function selectTier1(claims: readonly SemanticClaim[], intents: readonly PendingIntent[], ledgerCursor: number, roomChars: number): Tier1Result {
  const kept = mandatoryIndexes(claims, intents);
  let addedChars = 0;
  const take = (delta: number): boolean => {
    if (addedChars + delta > roomChars) return false;
    addedChars += delta;
    return true;
  };

  // 2. Other claims, whole, in claim order.
  const omittedClaims = new Map<SemanticField, number>();
  claims.forEach((claim, index) => {
    if (!kept.claims.has(index)) omittedClaims.set(claim.field, (omittedClaims.get(claim.field) ?? 0) + 1);
  });
  claims.forEach((claim, index) => {
    if (kept.claims.has(index)) return;
    const omitted = omittedClaims.get(claim.field) ?? 0;
    const delta = preambleLinesChars(claimLines(claim)) + optionalLineChars(omittedClaimsLine(omitted - 1)) - optionalLineChars(omittedClaimsLine(omitted));
    if (!take(delta)) return;
    kept.claims.add(index);
    omittedClaims.set(claim.field, omitted - 1);
  });

  // 3. Bounded tool intents: failed, then completed; newest first; at most the cap of each group.
  const bounded: Record<'pending' | 'completed', Indexed[]> = { pending: [], completed: [] };
  intents.forEach((intent, index) => {
    const group = intentGroup(intent);
    if (group !== 'never_dropped') bounded[group].push({ index, intent });
  });
  let stateEntries = kept.intents.size;
  const groups = [
    ['pending', PENDING_TOOL_INTENT_CAP],
    ['completed', COMPLETED_TOOL_INTENT_CAP],
  ] as const;
  for (const [group, cap] of groups) {
    const newestFirst = [...bounded[group]].sort((a, b) => b.intent.requested_seq - a.intent.requested_seq || b.index - a.index);
    let omitted = newestFirst.length;
    let listed = 0;
    for (const { index, intent } of newestFirst) {
      if (listed === cap) break;
      const delta =
        preambleLinesChars([intentLine(intent, ledgerCursor)]) +
        optionalLineChars(omittedIntentsLine(group, omitted - 1)) -
        optionalLineChars(omittedIntentsLine(group, omitted)) +
        canonicalChars(intent, 'pending intent') +
        (stateEntries > 0 ? 1 : 0);
      if (!take(delta)) continue;
      kept.intents.add(index);
      listed += 1;
      omitted -= 1;
      stateEntries += 1;
    }
  }

  return { selection: selectionOf(claims, kept.claims, intents, kept.intents), addedChars };
}
