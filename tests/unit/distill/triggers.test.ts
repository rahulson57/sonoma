/** SPEC-007 "Triggers" / DEC-006: only labeled checkpoints, handoff and `ckpt distill` reach the distiller. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DISTILL_TRIGGERS,
  distillForTrigger,
  distillRequestFor,
  shouldDistill,
  type DistillTrigger,
} from '../../../src/distill/index.js';
import type { Checkpoint } from '../../../src/model/types.js';
import { COMMIT, depsFor, fakeRun, reply, spyProvider, untouchableSource } from './support.js';

function checkpoint(id: string, ledgerSeq: number): Checkpoint {
  return {
    schemaVersion: 1,
    checkpoint_id: id,
    run_id: 'run_01J8Z3K5QW7XV2M9N4P6R8T0AC',
    parent_checkpoint_id: null,
    label: null,
    state_blob: { sha256: 'b'.repeat(64), size: 10 },
    state_hash: 'b'.repeat(64),
    workspace_commit: COMMIT,
    ledger_seq: ledgerSeq,
    usage: { input_tokens: 0, output_tokens: 0 },
    created_at: '2026-09-13T12:00:00.000Z',
  };
}

describe('distill triggers', () => {
  it('distills for label, handoff and distill only', () => {
    expect(DISTILL_TRIGGERS.filter(shouldDistill)).toEqual(['label', 'handoff', 'distill']);
    expect(() => shouldDistill('nightly' as DistillTrigger)).toThrow(/DISTILL_INVALID_REQUEST/);
  });

  it('returns null for automatic checkpoints and plain resume without reading the store or calling the provider', async () => {
    const run = await fakeRun({ events: 20, prevCursor: 5, cursor: 15 });
    const provider = spyProvider(reply([]));
    const deps = { ...depsFor(run, provider), source: untouchableSource(run.runId) };

    await expect(distillForTrigger('automatic', run.request, deps)).resolves.toBeNull();
    await expect(distillForTrigger('resume', run.request, deps)).resolves.toBeNull();
    expect(provider.prompts).toHaveLength(0);
  });

  it('distills a labeled checkpoint', async () => {
    const run = await fakeRun({ events: 20, prevCursor: 5, cursor: 15 });
    const provider = spyProvider(reply([]));

    const result = await distillForTrigger('label', run.request, depsFor(run, provider));

    expect(result?.projection.checkpointId).toBe('c_2');
    expect(provider.prompts).toHaveLength(1);
  });

  it('builds the request from the previous checkpoint cursor (exclusive) to this cursor (inclusive)', () => {
    const previous = checkpoint('c_1', 7);
    const current = checkpoint('c_2', 19);

    expect(distillRequestFor(current, previous)).toEqual({ checkpointId: 'c_2', stateHash: 'b'.repeat(64), ledgerRange: [7, 19], workspaceCommit: COMMIT });
    expect(distillRequestFor(previous, null).ledgerRange).toEqual([0, 7]);
  });

  it('names the SPEC-007 default provider and model', () => {
    expect(DEFAULT_PROVIDER).toBe('anthropic');
    expect(DEFAULT_MODEL).toBe('claude-haiku-4-5');
  });

  it('no file under src/distill/** contains the stale date-suffixed model id', async () => {
    // Assembled so this test file does not itself contain the stale id.
    const stale = ['claude-haiku-4-5', '20251001'].join('-');
    const root = fileURLToPath(new URL('../../../src/distill/', import.meta.url));
    const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const entry of files) {
      const file = path.join(entry.parentPath, entry.name);
      expect((await readFile(file, 'utf8')).includes(stale), `${file} contains ${stale}`).toBe(false);
    }
  });
});
