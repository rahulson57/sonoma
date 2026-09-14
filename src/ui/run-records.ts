/**
 * Read-only run listing for the inspector (challenge 01a09daa on SPEC-012: StorageBackend has no read method that
 * lists runs). Reads Local Storage's run records, `<store>/runs/<run_id>/run.json`, which are its source of truth.
 *
 * Only readdir and readFile: nothing is created, opened for writing or locked. A run directory without run.json is an
 * abandoned createRun and is skipped, as storage itself skips it. A malformed record is an error, not silently hidden.
 * Replace with a StorageBackend `listRuns()` read once storage provides one.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Run } from '../model/types.js';
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN } from '../storage/layout.js';

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined;
}

function parseRunRecord(text: string, runId: string): Run {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`run record of ${runId} is not JSON`, { cause: err });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`run record of ${runId} is not an object`);
  const { run_id, parent_run_id, forked_from_checkpoint, agent, created_at } = value as Record<string, unknown>;
  if (
    run_id !== runId ||
    typeof agent !== 'string' ||
    typeof created_at !== 'string' ||
    !(parent_run_id === null || (typeof parent_run_id === 'string' && RUN_ID_PATTERN.test(parent_run_id))) ||
    !(forked_from_checkpoint === null || (typeof forked_from_checkpoint === 'string' && CHECKPOINT_ID_PATTERN.test(forked_from_checkpoint))) ||
    (parent_run_id === null) !== (forked_from_checkpoint === null)
  ) {
    throw new Error(`run record of ${runId} is malformed`);
  }
  return { run_id: runId, parent_run_id, forked_from_checkpoint, agent, created_at };
}

/** Every run under `runsDir` (a LocalBackend's `layout.runs`), oldest first. A store with no runs directory has none. */
export async function readRunRecords(runsDir: string): Promise<Run[]> {
  let names: string[];
  try {
    names = (await readdir(runsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
  const runs: Run[] = [];
  for (const name of names) {
    if (!RUN_ID_PATTERN.test(name)) continue;
    let text: string;
    try {
      text = await readFile(path.join(runsDir, name, 'run.json'), 'utf8');
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') continue;
      throw err;
    }
    runs.push(parseRunRecord(text, name));
  }
  return runs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
}
