/**
 * Tier 1 claims from stored SemanticProjections (DEC-004 "consumers pick one, default: latest").
 *
 * Read-only: only `listForCheckpoint` is called, and nothing here calls the Distiller or a provider. The import is
 * type-only. Checkpoint ids repeat across runs (`c_1` in every run), so a projection counts only when its recorded
 * inputs are this checkpoint's own: state hash, workspace commit and cursor.
 */
import type { ProjectionStore } from '../distill/projection-store.js';
import type { ClaimSource } from './types.js';

export function latestProjectionClaims(store: Pick<ProjectionStore, 'listForCheckpoint'>): ClaimSource {
  return {
    async claimsFor(checkpoint) {
      const projections = await store.listForCheckpoint(checkpoint.checkpoint_id);
      // listForCheckpoint is oldest first, so the last match is the latest.
      const latest = projections
        .filter(
          (projection) =>
            projection.checkpointId === checkpoint.checkpoint_id &&
            projection.input.stateHash === checkpoint.state_hash &&
            projection.input.workspaceCommit === checkpoint.workspace_commit &&
            projection.input.ledgerRange[1] === checkpoint.ledger_seq,
        )
        .at(-1);
      return latest?.claims ?? [];
    },
  };
}
