/**
 * A real local store for CLI tests: a throwaway git repo (tests/helpers/tmpRepo.ts) holding one run built through the
 * real Checkpoint Engine. The store is closed before cliStore() returns, so main() opens it exactly as `ckpt` would.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CheckpointEngine } from '../../../src/engine/index.js';
import type { LedgerEventDraft } from '../../../src/model/types.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

export interface StoreBuilder {
  readonly engine: CheckpointEngine;
  readonly backend: LocalBackend;
  readonly runId: string;
  /** Writes a file into the user's worktree (the run's workspace until it is resumed or rolled back). */
  write(relPath: string, content: string): Promise<void>;
}

export interface CliStore {
  readonly repo: TmpGitRepo;
  readonly runId: string;
  cleanup(): Promise<void>;
}

/** A repo with `app.txt`, a started `claude-code` run, and whatever `build` records through the engine. */
export async function cliStore(build: (store: StoreBuilder) => Promise<void>): Promise<CliStore> {
  const repo = await tmpGitRepo({ files: { 'app.txt': 'v0\n' } });
  try {
    const backend = await LocalBackend.open({ repoDir: repo.dir });
    try {
      const engine = await CheckpointEngine.open({ backend, repoDir: repo.dir });
      const runId = (await engine.startRun({ agent: 'claude-code' })).run_id;
      await build({ engine, backend, runId, write: (relPath, content) => writeFile(path.join(repo.dir, relPath), content, 'utf8') });
      return { repo, runId, cleanup: () => repo.cleanup() };
    } finally {
      await backend.close();
    }
  } catch (err) {
    await repo.cleanup();
    throw err;
  }
}

/** Opens the store of `repoDir` for one read, then closes it. */
export async function withBackend<T>(repoDir: string, use: (backend: LocalBackend) => Promise<T>): Promise<T> {
  const backend = await LocalBackend.open({ repoDir });
  try {
    return await use(backend);
  } finally {
    await backend.close();
  }
}

/** A requested and committed side effect declared irreversible. */
export function irreversibleSideEffect(runId: string, id: string, type: string, target: string): LedgerEventDraft[] {
  return [
    { run_id: runId, type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: id, type, target, reversibility: 'irreversible' } },
    { run_id: runId, type: 'side_effect.committed', actor: 'runtime', payload: { side_effect_id: id } },
  ];
}
