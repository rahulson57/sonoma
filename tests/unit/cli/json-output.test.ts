/**
 * SPEC-013 "Returns": `--json` on `list`, `show` and `diff` emits machine-readable output. That output is one JSON
 * document on stdout, it parses, and it equals the value the module returned.
 */
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/index.js';
import { REF_1, REF_2, RUN_ID, fakeDeps, type FakeDeps } from './support.js';

type Pick = (fx: FakeDeps) => { readonly spy: { readonly mock: { readonly results: readonly { readonly value: unknown }[] } } };

const CASES: ReadonlyArray<readonly [string, readonly string[], Pick]> = [
  ['list --json', ['list', '--json'], (fx) => ({ spy: fx.modules.storage.listRuns })],
  ['list <runId> --json', ['list', RUN_ID, '--json'], (fx) => ({ spy: fx.modules.storage.listCheckpoints })],
  ['show <checkpointId> --json', ['show', REF_2, '--json'], (fx) => ({ spy: fx.modules.inspector.checkpoint })],
  ['diff <a> <b> --json', ['diff', REF_1, REF_2, '--json'], (fx) => ({ spy: fx.modules.engine.diff })],
];

describe('--json output (SPEC-013)', () => {
  it.each(CASES)('ckpt %s emits exactly the module return value', async (_name, argv, pick) => {
    const fx = fakeDeps();
    expect(await main(argv, fx.deps)).toBe(0);
    expect(fx.io.err).toBe('');

    const { spy } = pick(fx);
    expect(spy.mock.results).toHaveLength(1);
    const returned: unknown = await spy.mock.results[0]?.value;
    expect(returned).toBeDefined();
    const parsed: unknown = JSON.parse(fx.io.out);
    expect(parsed).toEqual(returned);
    // A single document: re-serialising what was parsed reproduces stdout exactly.
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(fx.io.out);
  });

  it.each([
    ['list', ['list']],
    ['show', ['show', REF_2]],
    ['diff', ['diff', REF_1, REF_2]],
  ])('without --json, ckpt %s renders text rather than JSON', async (_name, argv) => {
    const fx = fakeDeps();
    expect(await main(argv, fx.deps)).toBe(0);
    expect(() => JSON.parse(fx.io.out)).toThrow();
  });

  it('text output of show carries the three panes, and diff the four sections', async () => {
    const shown = fakeDeps();
    await main(['show', REF_2], shown.deps);
    for (const pane of ['STATE', 'WORKSPACE', 'LEDGER']) expect(shown.io.out).toMatch(new RegExp(`^${pane}$`, 'm'));

    const diffed = fakeDeps();
    await main(['diff', REF_1, REF_2], diffed.deps);
    for (const section of ['State', 'Workspace', 'Ledger', 'Side effects']) expect(diffed.io.out).toMatch(new RegExp(`^${section}\\b`, 'm'));
    expect(diffed.io.out).toContain('R100  a.txt -> b.txt');
  });
});
