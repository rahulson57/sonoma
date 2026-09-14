/**
 * The composition root over real modules. `ckpt` runs against a real store in a throwaway repo through the default
 * openLocalModules wiring: Local Storage, Checkpoint Engine, Context Builder, Inspector views and the Claude Code Adapter
 * hook handler. This proves the seams the unit tests spy on are wired to the modules that own them. No network: `ui`
 * binds an ephemeral loopback port and stops at once.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { main } from '../../../src/cli/index.js';
import { captureIo, type CaptureOptions } from '../../unit/cli/support.js';
import { cliStore, withBackend, type CliStore } from './support.js';

const HOOK_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../unit/adapters/claude-code/fixtures/user-prompt-submit.json');

describe('ckpt over a real store', () => {
  let store: CliStore | undefined;
  const current = (): CliStore => {
    if (store === undefined) throw new Error('the store was not built');
    return store;
  };

  beforeAll(async () => {
    store = await cliStore(async ({ engine, runId, write }) => {
      await engine.checkpoint(runId);
      await write('app.txt', 'v1\n');
      await engine.checkpoint(runId);
    });
  });
  afterAll(async () => {
    await store?.cleanup();
  });

  async function ckpt(argv: readonly string[], options: Omit<CaptureOptions, 'cwd'> = {}) {
    const io = captureIo({ ...options, cwd: current().repo.dir });
    const code = await main(argv, { io, untilShutdown: async () => undefined });
    return { code, io };
  }

  it('list, list <runId>, show --json and diff --json read the store', async () => {
    const { runId } = current();
    const runs = await ckpt(['list', '--json']);
    expect(runs.code).toBe(0);
    expect((JSON.parse(runs.io.out) as Array<{ run_id: string }>).map((run) => run.run_id)).toEqual([runId]);

    const checkpoints = await ckpt(['list', runId, '--json']);
    expect((JSON.parse(checkpoints.io.out) as Array<{ checkpoint_id: string }>).map((cp) => cp.checkpoint_id)).toEqual(['c_1', 'c_2']);
    expect((await ckpt(['list', runId])).io.out).toContain(`${runId}:c_2`);

    const shown = await ckpt(['show', `${runId}:c_2`, '--json']);
    expect(shown.code).toBe(0);
    const panes = JSON.parse(shown.io.out) as { state: { checkpoint_id: string }; workspace: { changedPaths: string[] } };
    expect(panes.state.checkpoint_id).toBe('c_2');
    expect(panes.workspace.changedPaths).toContain('app.txt');

    const diffed = await ckpt(['diff', `${runId}:c_1`, `${runId}:c_2`, '--json']);
    expect(diffed.code).toBe(0);
    expect((JSON.parse(diffed.io.out) as { workspace: unknown[] }).workspace).toContainEqual({ status: 'M', path: 'app.txt' });
  });

  it('show of a checkpoint that does not exist is a runtime error (exit 1), not a usage error', async () => {
    const result = await ckpt(['show', `${current().runId}:c_99`]);
    expect(result.code).toBe(1);
    expect(result.io.err).toMatch(/^ckpt show: /);
  });

  it('resume prints a fresh context on stdout and its summary on stderr', async () => {
    const result = await ckpt(['resume', `${current().runId}:c_1`]);
    expect(result.io.err).toMatch(/^Resumed .*:c_1 in /);
    expect(result.code).toBe(0);
    expect(result.io.out.trim().length).toBeGreaterThan(0);
  });

  it('fork prints the new run id, and list then shows that run forked from the checkpoint', async () => {
    const { runId } = current();
    const forked = await ckpt(['fork', `${runId}:c_2`]);
    expect(forked.code).toBe(0);
    const newRunId = forked.io.out.trim();
    expect(newRunId).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    const runs = JSON.parse((await ckpt(['list', '--json'])).io.out) as unknown[];
    expect(runs).toContainEqual(expect.objectContaining({ run_id: newRunId, parent_run_id: runId, forked_from_checkpoint: 'c_2' }));
  });

  it('reindex rebuilds the index and reports its counts', async () => {
    const result = await ckpt(['reindex']);
    expect(result.code).toBe(0);
    expect(result.io.out).toMatch(/^Reindexed 2 runs, \d+ checkpoints, \d+ events, \d+ projections, \d+ claims\.\n$/);
  });

  it('ui serves the read-only inspector on loopback and stops at shutdown', async () => {
    const result = await ckpt(['ui', '--port', '0']);
    expect(result.io.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.io.out).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+\//);
  });

  it('hook hands a bound run its stdin payload through the adapter and exits 0, and an unbound hook exits 0 without recording', async () => {
    const { repo, runId } = current();
    const payload = await readFile(HOOK_FIXTURE, 'utf8');
    const events = () => withBackend(repo.dir, (backend) => backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER }));
    const before = (await events()).length;

    const bound = await ckpt(['hook', 'UserPromptSubmit'], { env: { CKPT_RUN_ID: runId }, stdin: payload });
    expect(bound.io.err).toBe('');
    expect(bound.code).toBe(0);
    const after = await events();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.type).toBe('model.requested');

    const unbound = await ckpt(['hook', 'UserPromptSubmit'], { env: {}, stdin: payload });
    expect(unbound.code).toBe(0);
    expect(await events()).toHaveLength(before + 1);
  });
});
