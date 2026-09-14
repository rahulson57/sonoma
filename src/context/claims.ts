/**
 * Tier 1 semantic claims (DEC-036(1)).
 *
 * Selection walks the restored checkpoint's lineage nearest first (lineage.ts): the checkpoint itself, its parents,
 * then across a fork. The FIRST checkpoint with any claims is the source: its newest projection's claims, then its
 * agent_declared claims. DEC-006: a resume from an automatic checkpoint relies on the most recent earlier projection.
 * Never a sibling or an abandoned branch, because the walk only follows recorded parents and fork sources.
 *
 * Read-only: the ClaimSource answers for one checkpoint at a time, and nothing here calls the Distiller or a provider.
 */
import type { ProjectionStore } from '../distill/projection-store.js';
import type { Checkpoint, SemanticClaim } from '../model/types.js';
import { validateSemanticClaim, validateSemanticProjection } from '../model/validate.js';
import { corrupt } from './errors.js';
import { isRecord } from './guards.js';
import { checkpointKey, type LineageReader } from './lineage.js';
import type { ClaimSource } from './types.js';

export interface ClaimSelection {
  /** The checkpoint whose claims Tier 1 shows, or null when no checkpoint on the lineage has any. */
  readonly source: Checkpoint | null;
  /** The source's newest projection's claims, then its agent_declared claims. */
  readonly claims: readonly SemanticClaim[];
}

async function claimsRecordedAt(source: ClaimSource, checkpoint: Checkpoint): Promise<SemanticClaim[]> {
  const at = checkpointKey(checkpoint);
  const record: unknown = await source.claimsAt(checkpoint);
  if (!isRecord(record) || !Array.isArray(record['projections']) || !Array.isArray(record['declared'])) {
    throw corrupt(`the claim source did not return {projections, declared} for ${at}`);
  }

  const projections = record['projections'].map((projection: unknown, index) => {
    const result = validateSemanticProjection(projection);
    if (!result.ok) throw corrupt(`projection ${index} of ${at}: ${result.errors.join('; ')}`);
    if (result.value.checkpointId !== checkpoint.checkpoint_id) {
      throw corrupt(`the claim source returned a projection of ${result.value.checkpointId} for ${at}`);
    }
    return result.value;
  });
  const declared = record['declared'].map((claim: unknown, index) => {
    const result = validateSemanticClaim(claim);
    if (!result.ok) throw corrupt(`declared claim ${index} of ${at}: ${result.errors.join('; ')}`);
    if (result.value.origin !== 'agent_declared') throw corrupt(`declared claim ${index} of ${at} has origin ${result.value.origin}`);
    return result.value;
  });

  // Oldest first, so the newest projection is the last one.
  return [...(projections.at(-1)?.claims ?? []), ...declared];
}

/**
 * Walks the lineage until a checkpoint has claims or the lineage ends. There is no depth limit, so a valid lineage of any
 * length resolves. The walk still ends: same-run parents have strictly lower cursors (LineageReader), and a checkpoint
 * reached twice, which only fork records pointing in a circle can cause, raises ERR_CORRUPT.
 */
export async function selectClaims(source: ClaimSource | undefined, lineage: LineageReader, checkpoint: Checkpoint): Promise<ClaimSelection> {
  if (source === undefined) return { source: null, claims: [] };
  const visited = new Set<string>();
  let current: Checkpoint | null = checkpoint;
  while (current !== null) {
    const key = checkpointKey(current);
    if (visited.has(key)) throw corrupt(`the lineage of ${checkpointKey(checkpoint)} returns to ${key}`);
    visited.add(key);
    const claims = await claimsRecordedAt(source, current);
    if (claims.length > 0) return { source: current, claims };
    current = await lineage.previous(current);
  }
  return { source: null, claims: [] };
}

/**
 * ClaimSource over the Distiller's ProjectionStore. The store is keyed by checkpoint id, and checkpoint ids repeat
 * across runs (`c_1` in every run), so a projection counts as this checkpoint's only when its recorded inputs are this
 * checkpoint's own: state hash, workspace commit and cursor. That identifies the checkpoint; WHICH checkpoint's
 * claims a context shows is the lineage walk's decision (selectClaims), not this adapter's.
 * agent_declared claims have no store yet (S14, DEC-040), so it reports none. Only listForCheckpoint is called.
 */
export function projectionStoreClaims(store: Pick<ProjectionStore, 'listForCheckpoint'>): ClaimSource {
  return {
    async claimsAt(checkpoint) {
      const projections = (await store.listForCheckpoint(checkpoint.checkpoint_id)).filter(
        (projection) =>
          projection.checkpointId === checkpoint.checkpoint_id &&
          projection.input.stateHash === checkpoint.state_hash &&
          projection.input.workspaceCommit === checkpoint.workspace_commit &&
          projection.input.ledgerRange[1] === checkpoint.ledger_seq,
      );
      return { projections, declared: [] };
    },
  };
}
