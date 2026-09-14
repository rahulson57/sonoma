/**
 * SPEC-013 "Must never call the Distiller or any LLM outside `ckpt distill`" (DEC-005, DEC-006): `ckpt resume` and every
 * other command except `ckpt distill` call the Distiller provider 0 times. They never build a provider and never reach
 * the Distiller. Checked three ways:
 * - every command over spied fakes;
 * - a real `ckpt resume` over a real store;
 * - a source scan showing that only the distill command asks for a provider.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { main } from '../../../src/cli/index.js';
import type { DistillerProvider } from '../../../src/distill/index.js';
import { cliStore, withBackend } from '../../integration/cli/support.js';
import { REF_1, REF_2, RUN_ID, captureIo, fakeDeps } from './support.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const WITHOUT_LLM: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ['run claude', ['run', 'claude'], []],
  ['list', ['list'], []],
  ['list <runId>', ['list', RUN_ID], []],
  ['show', ['show', REF_2], []],
  ['diff', ['diff', REF_1, REF_2], []],
  ['resume', ['resume', REF_2], []],
  ['fork', ['fork', REF_1], []],
  ['rollback', ['rollback', REF_1], []],
  ['export', ['export', RUN_ID], ['y']],
  ['export --unsafe', ['export', RUN_ID, '--unsafe'], ['EXPORT UNSAFE']],
  ['import', ['import', 'checkpoint.bundle'], []],
  ['reindex', ['reindex'], []],
  ['ui', ['ui', '--port', '0'], []],
  ['hook (adapter-internal)', ['hook', 'Stop'], []],
  ['--help', ['--help'], []],
];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(abs)));
    else out.push(abs);
  }
  return out.sort();
}

describe('no LLM outside ckpt distill (SPEC-013)', () => {
  it.each(WITHOUT_LLM)('ckpt %s calls the Distiller provider 0 times', async (_name, argv, answers) => {
    const fx = fakeDeps(captureIo({ answers, env: { CKPT_RUN_ID: RUN_ID } }));
    expect(await main(argv, fx.deps)).toBe(0);
    expect(fx.deps.createProvider).not.toHaveBeenCalled();
    expect(fx.provider.complete).not.toHaveBeenCalled();
    expect(fx.modules.distiller.distill).not.toHaveBeenCalled();
  });

  it('control: ckpt distill does build the provider and reach the Distiller, so the zeros above are not vacuous', async () => {
    const fx = fakeDeps();
    expect(await main(['distill', REF_2], fx.deps)).toBe(0);
    expect(fx.deps.createProvider).toHaveBeenCalledTimes(1);
    expect(fx.modules.distiller.distill).toHaveBeenCalledTimes(1);
  });

  it('a real ckpt resume over a real store calls the provider 0 times and stores no projection', async () => {
    const store = await cliStore(async ({ engine, runId, write }) => {
      await engine.checkpoint(runId, { label: 'before-edit' });
      await write('app.txt', 'v1\n');
      await engine.checkpoint(runId);
    });
    try {
      const complete = vi.fn(async (_prompt: string) => ({ text: '{"claims": []}', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
      const provider: DistillerProvider = { name: 'stub', model: 'stub-model', complete };
      const createProvider = vi.fn(async () => provider);
      const io = captureIo({ cwd: store.repo.dir });

      expect(await main(['resume', `${store.runId}:c_1`], { io, createProvider })).toBe(0);
      expect(io.out.length).toBeGreaterThan(0);
      expect(createProvider).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(await withBackend(store.repo.dir, (backend) => backend.listProjections({ runId: store.runId, lineage: true }))).toEqual([]);
    } finally {
      await store.cleanup();
    }
  });

  it('only src/cli/commands/distill.ts asks for a provider', async () => {
    const askers: string[] = [];
    for (const file of await sourceFiles(path.join(REPO_ROOT, 'src', 'cli'))) {
      if (/\.createProvider\s*\(/.test(await readFile(file, 'utf8'))) askers.push(path.relative(REPO_ROOT, file).split(path.sep).join('/'));
    }
    expect(askers).toEqual(['src/cli/commands/distill.ts']);
  });
});
