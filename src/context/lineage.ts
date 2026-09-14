/**
 * Checkpoint lineage reads for Tier 1 claims and the Tier 2 diff (DEC-036(1)).
 *
 * A checkpoint's lineage, nearest first: the checkpoint itself, then its parents in the same run
 * (parent_checkpoint_id), then, once a forked run's first checkpoint is reached, the checkpoint the run was forked
 * from, and that checkpoint's own lineage. The Checkpoint Engine records the run's CURRENT checkpoint as the parent,
 * and resume / rollback move it, so the chain never passes through a sibling or an abandoned branch.
 *
 * A run is a fork when its first ledger event (seq 1) is `agent.forked`: the engine's fork() creates the run with an
 * empty ledger and appends that event before anything else can. Its payload names the source (parent_run_id,
 * forked_from_checkpoint, ledger_seq, workspace_commit), so crossing a fork needs only getEvents and getCheckpoint.
 * The seq-1 read lies inside [1, cursor] of every checkpoint of that run.
 *
 * There is no depth limit: a valid lineage of any length resolves (SPEC-002's numbers are an envelope, not a cap). A walk
 * still ends. Within a run each parent's cursor must be strictly lower than its child's (#loadParent refuses anything
 * else), so a same-run chain cannot repeat. Across runs, a walk that reaches a checkpoint twice has followed fork
 * records that point in a circle, and selectClaims raises ERR_CORRUPT.
 */
import type { Checkpoint } from '../model/types.js';
import { validateCheckpoint } from '../model/validate.js';
import { corrupt } from './errors.js';
import { isRecord } from './guards.js';
import type { ContextStorage } from './types.js';

export function checkpointKey(checkpoint: Checkpoint): string {
  return `${checkpoint.run_id}:${checkpoint.checkpoint_id}`;
}

async function readCheckpoint(storage: ContextStorage, runId: string, checkpointId: string, what: string): Promise<Checkpoint> {
  const result = validateCheckpoint(await storage.getCheckpoint({ run_id: runId, checkpoint_id: checkpointId }));
  if (!result.ok) throw corrupt(`${what} ${runId}:${checkpointId}: ${result.errors.join('; ')}`);
  const checkpoint = result.value;
  if (checkpoint.run_id !== runId || checkpoint.checkpoint_id !== checkpointId) {
    throw corrupt(`storage returned ${checkpointKey(checkpoint)} for ${what} ${runId}:${checkpointId}`);
  }
  return checkpoint;
}

/** Memoized lineage reads for one build. */
export class LineageReader {
  readonly #storage: ContextStorage;
  readonly #parents = new Map<string, Promise<Checkpoint | null>>();
  readonly #origins = new Map<string, Promise<Checkpoint | null>>();

  constructor(storage: ContextStorage) {
    this.#storage = storage;
  }

  /** The parent checkpoint in the same run, or null for a run's first checkpoint. */
  parentOf(checkpoint: Checkpoint): Promise<Checkpoint | null> {
    const key = checkpointKey(checkpoint);
    let parent = this.#parents.get(key);
    if (parent === undefined) {
      parent = this.#loadParent(checkpoint);
      this.#parents.set(key, parent);
    }
    return parent;
  }

  /** For a run's first checkpoint in a forked run: the checkpoint the run was forked from. Otherwise null. */
  forkOriginOf(checkpoint: Checkpoint): Promise<Checkpoint | null> {
    if (checkpoint.parent_checkpoint_id !== null) return Promise.resolve(null);
    let origin = this.#origins.get(checkpoint.run_id);
    if (origin === undefined) {
      origin = this.#loadForkOrigin(checkpoint);
      this.#origins.set(checkpoint.run_id, origin);
    }
    return origin;
  }

  /** The next checkpoint on the lineage, nearest first: the parent, else the fork source, else null. */
  async previous(checkpoint: Checkpoint): Promise<Checkpoint | null> {
    return checkpoint.parent_checkpoint_id !== null ? this.parentOf(checkpoint) : this.forkOriginOf(checkpoint);
  }

  async #loadParent(checkpoint: Checkpoint): Promise<Checkpoint | null> {
    const parentId = checkpoint.parent_checkpoint_id;
    if (parentId === null) return null;
    const parent = await readCheckpoint(this.#storage, checkpoint.run_id, parentId, 'parent checkpoint');
    if (parent.ledger_seq >= checkpoint.ledger_seq) {
      throw corrupt(`parent ${parentId} cursor ${parent.ledger_seq} is not before ${checkpoint.checkpoint_id} cursor ${checkpoint.ledger_seq}`);
    }
    return parent;
  }

  async #loadForkOrigin(root: Checkpoint): Promise<Checkpoint | null> {
    const runId = root.run_id;
    const events: unknown = await this.#storage.getEvents(runId, { fromSeq: 1, toSeq: 1 });
    if (!Array.isArray(events)) throw corrupt(`storage did not return an event list for ${runId} [1, 1]`);
    for (const event of events) {
      if (!isRecord(event) || event['run_id'] !== runId || event['seq'] !== 1) {
        throw corrupt(`storage returned an event outside ${runId} [1, 1]`);
      }
    }
    const first: unknown = events[0];
    if (!isRecord(first)) throw corrupt(`${runId} has checkpoint ${root.checkpoint_id} but no ledger event at seq 1`);
    if (first['type'] !== 'agent.forked') return null;

    const payload = first['payload'];
    const parentRunId = isRecord(payload) ? payload['parent_run_id'] : undefined;
    const checkpointId = isRecord(payload) ? payload['forked_from_checkpoint'] : undefined;
    const ledgerSeq = isRecord(payload) ? payload['ledger_seq'] : undefined;
    const commit = isRecord(payload) ? payload['workspace_commit'] : undefined;
    if (typeof parentRunId !== 'string' || typeof checkpointId !== 'string' || typeof ledgerSeq !== 'number' || typeof commit !== 'string') {
      throw corrupt(`the agent.forked event of ${runId} does not name its source checkpoint`);
    }
    if (parentRunId === runId) throw corrupt(`the agent.forked event of ${runId} names its own run as the source`);
    const source = await readCheckpoint(this.#storage, parentRunId, checkpointId, 'fork source checkpoint');
    if (source.ledger_seq !== ledgerSeq || source.workspace_commit !== commit) {
      throw corrupt(`fork source ${parentRunId}:${checkpointId} does not match the agent.forked event of ${runId}`);
    }
    return source;
  }
}
