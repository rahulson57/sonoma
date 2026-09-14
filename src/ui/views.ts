/**
 * The inspector's JSON views (SPEC-012), computed only from StorageBackend READ methods, a read-only run listing and
 * Checkpoint Engine `diff()`. The dependency types (types.ts) carry no write method, so no view can mutate a run,
 * checkpoint, ref, blob, the ledger or the index. Nothing here calls an LLM or the Distiller.
 *
 * Points SPEC-012 leaves open, resolved as recorded in challenge 01a09daa and MSG-3425:
 * - Checkpoint ids are the CLI ref form `run_<ulid>:c_<n>`, because `c_<n>` repeats across runs.
 * - A run's timeline holds its own checkpoints and those of every run forked from it (transitively), ordered by
 *   createdAt. A fork's first checkpoint (no same-run parent) has parentId `<parent_run_id>:<forked_from_checkpoint>`.
 * - A ledger range is `[parent cursor (exclusive), this cursor]`, using the same-run parent or 0 without one. That is
 *   the Distiller's DistillRequest.ledgerRange (DEC-030).
 * - changedPaths come from the same-run parent's commit, else the fork source's commit, else (for a root checkpoint)
 *   every path of the tree.
 * - The LEDGER pane lists the range's events under the display policy (display.ts).
 */
import { WorkspaceGit, deriveSideEffects, parseCheckpointRef, type CheckpointDiff, type CheckpointRef } from '../engine/index.js';
import type { Checkpoint, LedgerEvent, Run } from '../model/types.js';
import { isStorageError } from '../storage/errors.js';
import { RUN_ID_PATTERN, checkpointNumber } from '../storage/layout.js';
import { displayEvent } from './display.js';
import type { CheckpointPanes, InspectorBackend, InspectorEngine, ListRuns, TimelineNode } from './types.js';

/** A request the inspector answers with a client error and `{error}`. */
export class InspectorError extends Error {
  override readonly name = 'InspectorError';
  readonly status: 400 | 404;

  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

/** `tool.requested` payload members naming the tool, in order of preference (no spec fixes the key). */
export const TOOL_NAME_KEYS = ['tool_name', 'name', 'tool'] as const;

export function checkpointRefText(runId: string, checkpointId: string): string {
  return `${runId}:${checkpointId}`;
}

function parseRef(text: string): CheckpointRef {
  try {
    return parseCheckpointRef(text);
  } catch {
    throw new InspectorError(404, `unknown checkpoint ${JSON.stringify(text)} (a checkpoint id is run_<ulid>:c_<n>)`);
  }
}

async function orNotFound<T>(pending: Promise<T>, message: string): Promise<T> {
  try {
    return await pending;
  } catch (err) {
    if (isStorageError(err, 'ERR_NOT_FOUND')) throw new InspectorError(404, message);
    throw err;
  }
}

function timelineNode(run: Run, checkpoint: Checkpoint, sameRun: ReadonlyMap<string, Checkpoint>): TimelineNode {
  let parentId: string | null = null;
  if (checkpoint.parent_checkpoint_id !== null) {
    parentId = checkpointRefText(checkpoint.run_id, checkpoint.parent_checkpoint_id);
  } else if (run.parent_run_id !== null && run.forked_from_checkpoint !== null) {
    parentId = checkpointRefText(run.parent_run_id, run.forked_from_checkpoint);
  }
  const parent = checkpoint.parent_checkpoint_id === null ? undefined : sameRun.get(checkpoint.parent_checkpoint_id);
  return {
    checkpointId: checkpointRefText(checkpoint.run_id, checkpoint.checkpoint_id),
    parentId,
    runId: checkpoint.run_id,
    label: checkpoint.label,
    createdAt: checkpoint.created_at,
    ledgerRange: [Math.min(parent?.ledger_seq ?? 0, checkpoint.ledger_seq), checkpoint.ledger_seq],
  };
}

function toolsUsed(events: readonly LedgerEvent[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool.requested' || event.payload === null) continue;
    for (const key of TOOL_NAME_KEYS) {
      const value = event.payload[key];
      if (typeof value === 'string' && value !== '') {
        names.add(value);
        break;
      }
    }
  }
  return [...names];
}

export class InspectorViews {
  readonly #backend: InspectorBackend;
  readonly #engine: InspectorEngine;
  readonly #listRuns: ListRuns;
  #git: Promise<WorkspaceGit> | undefined;

  constructor(deps: { readonly backend: InspectorBackend; readonly engine: InspectorEngine; readonly listRuns: ListRuns }) {
    this.#backend = deps.backend;
    this.#engine = deps.engine;
    this.#listRuns = deps.listRuns;
  }

  /** GET /api/runs */
  runs(): Promise<Run[]> {
    return this.#listRuns();
  }

  /** GET /api/runs/:runId/checkpoints */
  async timeline(runId: string): Promise<TimelineNode[]> {
    const runs = await this.#listRuns();
    const byId = new Map(runs.map((run) => [run.run_id, run]));
    if (!RUN_ID_PATTERN.test(runId) || !byId.has(runId)) throw new InspectorError(404, `unknown run ${JSON.stringify(runId)}`);

    const forks = new Map<string, Run[]>();
    for (const run of runs) {
      if (run.parent_run_id === null) continue;
      const list = forks.get(run.parent_run_id) ?? [];
      list.push(run);
      forks.set(run.parent_run_id, list);
    }
    // The run, then the runs forked from it, breadth first.
    const order: Run[] = [];
    const seen = new Set<string>();
    const queue: string[] = [runId];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const run = byId.get(next);
      if (run === undefined || seen.has(next)) continue;
      seen.add(next);
      order.push(run);
      for (const child of forks.get(next) ?? []) queue.push(child.run_id);
    }

    const entries: Array<{ node: TimelineNode; at: number; runIndex: number; n: number }> = [];
    for (const [runIndex, run] of order.entries()) {
      const checkpoints = await this.#backend.listCheckpoints(run.run_id);
      const sameRun = new Map(checkpoints.map((checkpoint) => [checkpoint.checkpoint_id, checkpoint]));
      for (const checkpoint of checkpoints) {
        entries.push({
          node: timelineNode(run, checkpoint, sameRun),
          at: Date.parse(checkpoint.created_at),
          runIndex,
          n: checkpointNumber(checkpoint.checkpoint_id),
        });
      }
    }
    entries.sort((a, b) => a.at - b.at || a.runIndex - b.runIndex || a.n - b.n);
    return entries.map((entry) => entry.node);
  }

  /** GET /api/checkpoints/:id */
  async checkpoint(id: string): Promise<CheckpointPanes> {
    const ref = parseRef(id);
    const at = { run_id: ref.runId, checkpoint_id: ref.checkpointId };
    const checkpoint = await orNotFound(this.#backend.getCheckpoint(at), `unknown checkpoint ${JSON.stringify(id)}`);
    const parent =
      checkpoint.parent_checkpoint_id === null
        ? null
        : await this.#backend.getCheckpoint({ run_id: checkpoint.run_id, checkpoint_id: checkpoint.parent_checkpoint_id });

    const [state, changedPaths, history] = await Promise.all([
      this.#backend.getState(at),
      this.#changedPaths(checkpoint, parent),
      this.#backend.getEvents(checkpoint.run_id, { fromSeq: 1, toSeq: checkpoint.ledger_seq }),
    ]);
    const to = checkpoint.ledger_seq;
    const from = Math.min(parent?.ledger_seq ?? 0, to);
    const inRange = history.filter((event) => event.seq > from && event.seq <= to);
    return {
      state,
      workspace: { commit: checkpoint.workspace_commit, changedPaths },
      ledger: {
        range: [from, to],
        toolsUsed: toolsUsed(inRange),
        modelCalls: inRange.filter((event) => event.type === 'model.requested').length,
        // The whole history up to the cursor, so a request before the range still completes a commit inside it.
        sideEffects: deriveSideEffects(history, from, to),
        events: inRange.map(displayEvent),
      },
    };
  }

  /** GET /api/diff?a=&b= — exactly the Checkpoint Engine's `diff(a, b)`. */
  async diff(a: string | null, b: string | null): Promise<CheckpointDiff> {
    if (a === null || a === '' || b === null || b === '') throw new InspectorError(400, 'diff needs both ?a= and ?b= checkpoint ids');
    const refA = parseRef(a);
    const refB = parseRef(b);
    return orNotFound(this.#engine.diff(refA, refB), `unknown checkpoint in diff ${JSON.stringify(a)} .. ${JSON.stringify(b)}`);
  }

  async #changedPaths(checkpoint: Checkpoint, parent: Checkpoint | null): Promise<string[]> {
    const git = await this.#workspaceGit();
    const base = parent !== null ? parent.workspace_commit : await this.#forkSourceCommit(checkpoint.run_id);
    if (base === null) return [...(await git.readTree(checkpoint.workspace_commit)).keys()];
    return (await git.diffNameStatus(base, checkpoint.workspace_commit)).map((entry) => entry.path);
  }

  async #forkSourceCommit(runId: string): Promise<string | null> {
    const run = (await this.#listRuns()).find((candidate) => candidate.run_id === runId);
    if (run === undefined || run.parent_run_id === null || run.forked_from_checkpoint === null) return null;
    const source = await this.#backend.getCheckpoint({ run_id: run.parent_run_id, checkpoint_id: run.forked_from_checkpoint });
    return source.workspace_commit;
  }

  #workspaceGit(): Promise<WorkspaceGit> {
    if (this.#git === undefined) {
      const opening = WorkspaceGit.open(this.#engine.repoRoot);
      this.#git = opening;
      opening.catch(() => {
        if (this.#git === opening) this.#git = undefined;
      });
    }
    return this.#git;
  }
}
