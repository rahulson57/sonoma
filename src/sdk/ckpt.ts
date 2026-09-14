/**
 * The State SDK (SPEC-010). `save()` lets agent code declare semantic state that an observation adapter cannot
 * infer. It owns no persistence:
 * 1. validate the declaration; on failure nothing reaches the Engine;
 * 2. engine.record() one `state.declared` observation, which the Engine sanitizes before sealing;
 * 3. wrap each declared value as an `agent_declared` claim citing that event's id;
 * 4. engine.checkpoint(runId, {label, declaredState}). The Engine sanitizes the claims, creates a NEW checkpoint and
 *    stores them as its declared projection. Earlier checkpoints are never touched.
 *
 * SAVE IS NOT ATOMIC. The Engine writes the declared claims AFTER storage's createCheckpoint has already made the
 * checkpoint durable; these are two separate writes.
 * - If the claims write fails, save() rejects with that error and returns no CheckpointRef. The checkpoint itself
 *   remains, without declared claims.
 * - If the process crashes between the two writes, the checkpoint exists WITHOUT its declared claims, and reindex()
 *   cannot recreate them. The sanitized `state.declared` ledger event still records the declaration; it is the
 *   recovery path, and nothing turns it back into claims automatically.
 * Storage-level atomicity belongs to S14 and is out of this module's scope (DEC-043).
 *
 * The Engine instance is injected, and this module imports only its types, so the SDK carries no storage, git or
 * redaction code. No LLM or Distiller is called; a label only makes the Engine emit its own fire-and-forget request.
 *
 * Saves through one Ckpt run one at a time, in call order. The Engine accepts claims only for `state.declared` events
 * recorded since the parent checkpoint, so a record→checkpoint pair must not interleave with another save's
 * checkpoint on the same run.
 */
import type { CheckpointOptions, CheckpointRef } from '../engine/index.js';
import type { Checkpoint, LedgerEvent, LedgerEventDraft } from '../model/types.js';
import { DECLARED_EVENT_TYPE, declaredClaims, declaredStateDraft } from './claims.js';
import { validateDeclaredState, validateSaveOptions, type DeclaredState, type DeclaredStateInput, type SaveOptions } from './validate.js';

/** The two Checkpoint Engine operations save() forwards to. CheckpointEngine satisfies it. */
export interface DeclaredStateEngine {
  record(observations: readonly LedgerEventDraft[]): Promise<LedgerEvent[]>;
  checkpoint(runId: string, options?: CheckpointOptions): Promise<Checkpoint>;
}

export interface CkptOptions {
  readonly engine: DeclaredStateEngine;
  /** The run declarations belong to. The composition root creates or chooses it; the SDK never starts one. */
  readonly runId: string;
}

export interface Ckpt {
  readonly runId: string;
  /**
   * Declares semantic state and resolves to the new checkpoint. Rejects with CkptValidationError (nothing sent to the
   * Engine) for invalid input, and with the Engine's error if recording, checkpointing or storing the claims fails.
   */
  save(state: DeclaredStateInput, opts?: SaveOptions): Promise<CheckpointRef>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createCkpt(options: CkptOptions): Ckpt {
  if (!isRecord(options)) throw new TypeError('createCkpt needs {engine, runId}');
  const { engine, runId } = options;
  if (!isRecord(engine) || typeof engine.record !== 'function' || typeof engine.checkpoint !== 'function') {
    throw new TypeError('createCkpt needs an engine with record() and checkpoint()');
  }
  if (typeof runId !== 'string' || runId === '') throw new TypeError('createCkpt needs a non-empty runId');

  const forward = async (declared: DeclaredState, label: string | null): Promise<CheckpointRef> => {
    const [event] = await engine.record([declaredStateDraft(runId, declared)]);
    if (event === undefined || event.type !== DECLARED_EVENT_TYPE || event.run_id !== runId) {
      throw new Error(`the Checkpoint Engine did not return the ${DECLARED_EVENT_TYPE} event it appended for ${runId}`);
    }
    const checkpoint = await engine.checkpoint(runId, { label, declaredState: declaredClaims(declared, event.event_id) });
    return { runId: checkpoint.run_id, checkpointId: checkpoint.checkpoint_id };
  };

  let tail: Promise<void> = Promise.resolve();
  return {
    runId,
    save(state: DeclaredStateInput, opts?: SaveOptions): Promise<CheckpointRef> {
      let declared: DeclaredState;
      let label: string | null;
      try {
        // Validated at call time: a caller mutating its object while an earlier save runs changes nothing.
        declared = validateDeclaredState(state);
        label = validateSaveOptions(opts);
      } catch (err) {
        return Promise.reject(err);
      }
      const run = (): Promise<CheckpointRef> => forward(declared, label);
      const result = tail.then(run, run);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
