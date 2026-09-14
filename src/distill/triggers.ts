/**
 * The only door to the distiller (SPEC-007 "Triggers", DEC-006). The Checkpoint Engine and the CLI call
 * distillForTrigger with the trigger they are serving. An automatic checkpoint or a plain resume returns
 * null before anything is read, and the provider is never called.
 */
import type { Checkpoint } from '../model/types.js';
import { distill, type DistillDeps } from './distiller.js';
import { DistillError } from './errors.js';
import type { DistillRequest, DistillResult } from './types.js';

export const DISTILL_TRIGGERS = [
  /** Checkpoint created by the runtime without a label: never distilled. */
  'automatic',
  /** `ckpt checkpoint --label <name>`. */
  'label',
  /** `ckpt fork` / export for handoff. */
  'handoff',
  /** `ckpt distill <checkpointId> [--model]`. */
  'distill',
  /** Plain `ckpt resume`: consumes the existing state object, never distilled. */
  'resume',
] as const;

export type DistillTrigger = (typeof DISTILL_TRIGGERS)[number];

export function shouldDistill(trigger: DistillTrigger): boolean {
  switch (trigger) {
    case 'label':
    case 'handoff':
    case 'distill':
      return true;
    case 'automatic':
    case 'resume':
      return false;
    default:
      throw new DistillError('DISTILL_INVALID_REQUEST', `unknown distill trigger ${JSON.stringify(trigger)}`);
  }
}

/** Distills when the trigger calls for it; otherwise returns null without touching the provider or the store. */
export async function distillForTrigger(trigger: DistillTrigger, request: DistillRequest, deps: DistillDeps): Promise<DistillResult | null> {
  if (!shouldDistill(trigger)) return null;
  return distill(request, deps);
}

/**
 * The request for `checkpoint`, whose ledger delta starts after `previous` (its parent, or null for a
 * run's first checkpoint).
 */
export function distillRequestFor(checkpoint: Checkpoint, previous: Checkpoint | null): DistillRequest {
  return {
    checkpointId: checkpoint.checkpoint_id,
    stateHash: checkpoint.state_hash,
    ledgerRange: [previous === null ? 0 : previous.ledger_seq, checkpoint.ledger_seq],
    workspaceCommit: checkpoint.workspace_commit,
  };
}
