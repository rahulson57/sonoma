/**
 * SPEC-013 "Exit codes": an unknown command or a missing required argument exits 2 with the usage text on stderr. So do
 * the other usage errors: a malformed id, an unknown or repeated flag, an extra argument. No module is touched first.
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS, main } from '../../../src/cli/index.js';
import { REF_1, REF_2, RUN_ID, calledSpies, fakeDeps } from './support.js';

const USAGE = 'Usage: ckpt <command> [args] [flags]';

const UNKNOWN_COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['no command at all', []],
  ['an unknown command', ['frobnicate']],
  ['a flag in place of a command', ['--verbose']],
  ['a command name in the wrong case', ['LIST']],
  ['checkpoint, which v1 does not ship as a command', ['checkpoint', REF_1]],
];

const MISSING_ARGUMENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['run without an agent', ['run']],
  ['show without a checkpoint id', ['show']],
  ['diff without checkpoint ids', ['diff']],
  ['diff with only one checkpoint id', ['diff', REF_1]],
  ['resume without a checkpoint id', ['resume']],
  ['fork without a checkpoint id', ['fork']],
  ['rollback without a checkpoint id', ['rollback']],
  ['export without a target', ['export']],
  ['export --unsafe without a target', ['export', '--unsafe']],
  ['import without a bundle path', ['import']],
  ['distill without a checkpoint id', ['distill']],
];

const BAD_ARGUMENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['run with an agent other than claude', ['run', 'codex']],
  ['list with a malformed run id', ['list', 'run_nope']],
  ['list with two run ids', ['list', RUN_ID, RUN_ID]],
  ['show with a bare c_<n>', ['show', 'c_1']],
  ['diff with a malformed second id', ['diff', REF_1, 'c_2']],
  ['diff with a third id', ['diff', REF_1, REF_2, REF_2]],
  ['rollback given a run id', ['rollback', RUN_ID]],
  ['export with a malformed target', ['export', 'everything']],
  ['reindex with an argument', ['reindex', 'now']],
  ['ui with a non-numeric port', ['ui', '--port', 'http']],
  ['ui with an out-of-range port', ['ui', '--port=70000']],
  ['ui with --port and no value', ['ui', '--port']],
  ['ui with a positional argument', ['ui', '7420']],
  ['an unknown flag', ['list', '--verbose']],
  ['a single-dash flag', ['show', REF_1, '-j']],
  ['a flag another command owns', ['show', REF_1, '--unsafe']],
  ['a repeated flag', ['diff', REF_1, REF_2, '--json', '--json']],
  ['a value on a boolean flag', ['list', '--json=yes']],
];

describe('usage errors exit 2 with usage on stderr (SPEC-013)', () => {
  it.each([...UNKNOWN_COMMANDS, ...MISSING_ARGUMENTS, ...BAD_ARGUMENTS])('%s', async (_name, argv) => {
    const fx = fakeDeps();
    expect(await main(argv, fx.deps)).toBe(2);
    expect(fx.io.err).toContain(USAGE);
    expect(fx.io.err.startsWith('ckpt: ')).toBe(true);
    expect(fx.io.out).toBe('');
    expect(calledSpies(fx)).toEqual([]);
  });

  it('names the unknown command and the missing argument', async () => {
    const unknown = fakeDeps();
    await main(['frobnicate'], unknown.deps);
    expect(unknown.io.err).toMatch(/^ckpt: unknown command "frobnicate"\n/);

    const missing = fakeDeps();
    await main(['show'], missing.deps);
    expect(missing.io.err).toMatch(/^ckpt: ckpt show: missing argument \(ckpt show <checkpointId> \[--json\]\)\n/);
  });

  it('the usage text lists all 12 commands and not the adapter-internal hook command', async () => {
    const fx = fakeDeps();
    await main(['frobnicate'], fx.deps);
    expect(Object.keys(COMMANDS)).toEqual(['run', 'list', 'show', 'diff', 'resume', 'fork', 'rollback', 'export', 'import', 'distill', 'reindex', 'ui']);
    for (const spec of Object.values(COMMANDS)) expect(fx.io.err).toContain(spec.usage);
    expect(fx.io.err).not.toContain('ckpt hook');
  });

  it.each([['--help'], ['-h'], ['help']])('%s prints usage on stdout and exits 0', async (flag) => {
    const fx = fakeDeps();
    expect(await main([flag], fx.deps)).toBe(0);
    expect(fx.io.out).toContain(USAGE);
    expect(fx.io.err).toBe('');
    expect(calledSpies(fx)).toEqual([]);
  });

  it('a runtime failure is exit 1, not a usage error', async () => {
    const fx = fakeDeps();
    fx.deps.openModules.mockRejectedValueOnce(new Error('not a git repository'));
    expect(await main(['list'], fx.deps)).toBe(1);
    expect(fx.io.err).toBe('ckpt list: not a git repository\n');
  });

  it('flags may come before positionals, and -- ends flag parsing', async () => {
    const fx = fakeDeps();
    expect(await main(['show', '--json', REF_2], fx.deps)).toBe(0);
    const imported = fakeDeps();
    expect(await main(['import', '--', '--odd-name.bundle'], imported.deps)).toBe(0);
    expect(imported.modules.bundle.importBundle.mock.calls[0]?.[0]).toMatch(/--odd-name\.bundle$/);
  });
});
