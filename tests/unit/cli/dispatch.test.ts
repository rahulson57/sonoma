/**
 * SPEC-013 "Commands": each of the 12 commands dispatches to the module in the Commands table. Every module method is a
 * spy. The methods the table names are called exactly once, with the parsed arguments, and nothing else is called except
 * the reads a command needs to build that call. Commands that use the store open it once and close it once.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/index.js';
import { CWD, REF_1, REF_2, RUN_ID, captureIo, calledSpies, fakeDeps, ref, spiesOf } from './support.js';

interface Case {
  readonly argv: readonly string[];
  /** Spies that must be called exactly once, with exactly these arguments unless null. */
  readonly calls: Readonly<Record<string, readonly unknown[] | null>>;
  /** Further spies the command may call: the reads it needs to build the module call. */
  readonly reads?: readonly string[];
  readonly answers?: readonly string[];
  /** Default true. `run` does not: the adapter's runner opens and closes the store itself. */
  readonly opensStore?: boolean;
}

const CASES: ReadonlyArray<readonly [string, Case]> = [
  [
    'run claude [args]',
    {
      argv: ['run', 'claude', '--model', 'sonnet', 'fix the failing test'],
      calls: { 'deps.createRunner': null, 'runner.run': [['--model', 'sonnet', 'fix the failing test']] },
      opensStore: false,
    },
  ],
  ['list', { argv: ['list'], calls: { 'storage.listRuns': [] } }],
  ['list <runId>', { argv: ['list', RUN_ID], calls: { 'storage.listCheckpoints': [RUN_ID] } }],
  ['show <checkpointId>', { argv: ['show', REF_2], calls: { 'inspector.checkpoint': [REF_2] } }],
  ['diff <a> <b>', { argv: ['diff', REF_1, REF_2], calls: { 'engine.diff': [ref('c_1'), ref('c_2')] } }],
  ['resume <checkpointId>', { argv: ['resume', REF_2], calls: { 'engine.resume': [ref('c_2')], 'context.buildResumeContext': null } }],
  ['fork <checkpointId>', { argv: ['fork', REF_1], calls: { 'engine.fork': [ref('c_1')] } }],
  ['rollback <checkpointId>', { argv: ['rollback', REF_1], calls: { 'engine.rollback': [ref('c_1')] } }],
  [
    'export <id>',
    { argv: ['export', RUN_ID], answers: ['y'], calls: { 'bundle.planExport': [RUN_ID, { unsafe: false }], 'bundle.writeBundle': null } },
  ],
  ['import <bundle>', { argv: ['import', 'in/checkpoint.bundle'], calls: { 'bundle.importBundle': [path.resolve(CWD, 'in/checkpoint.bundle')] } }],
  [
    'distill <checkpointId>',
    {
      argv: ['distill', REF_2],
      calls: { 'deps.createProvider': null, 'distiller.distill': null },
      reads: ['storage.getCheckpoint', 'storage.listCheckpoints', 'storage.listProjections'],
    },
  ],
  ['reindex', { argv: ['reindex'], calls: { 'storage.reindex': [] } }],
  ['ui [--port]', { argv: ['ui', '--port', '0'], calls: { 'inspector.start': [{ port: 0 }], 'deps.untilShutdown': [] } }],
];

describe('ckpt command dispatch (SPEC-013 Commands table)', () => {
  it('covers all 12 commands', () => {
    expect(new Set(CASES.map(([, c]) => c.argv[0])).size).toBe(12);
  });

  it.each(CASES)('ckpt %s', async (_name, c) => {
    const fx = fakeDeps(captureIo({ answers: c.answers ?? [] }));
    const code = await main(c.argv, fx.deps);

    // stderr may carry a command's summary or warnings (resume, fork, rollback), but never an error line.
    expect(fx.io.err).not.toMatch(/^ckpt\b/m);
    expect(code).toBe(0);
    const spies = spiesOf(fx);
    for (const [name, args] of Object.entries(c.calls)) {
      const spy = spies.get(name);
      expect(spy, name).toBeDefined();
      expect(spy?.mock.calls, name).toHaveLength(1);
      if (args !== null) expect(spy?.mock.calls[0], name).toEqual(args);
    }
    const opensStore = c.opensStore ?? true;
    const allowed = new Set([...Object.keys(c.calls), ...(c.reads ?? []), ...(opensStore ? ['deps.openModules', 'close'] : [])]);
    expect(fx.deps.openModules).toHaveBeenCalledTimes(opensStore ? 1 : 0);
    expect(fx.modules.close).toHaveBeenCalledTimes(opensStore ? 1 : 0);
    expect(calledSpies(fx).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('distill hands the Distiller the checkpoint request, the provider it built and the run budget', async () => {
    const fx = fakeDeps();
    expect(await main(['distill', REF_2], fx.deps)).toBe(0);
    const [c1, c2] = fx.values.checkpoints;
    expect(fx.modules.distiller.distill).toHaveBeenCalledWith(
      { checkpointId: 'c_2', stateHash: c2?.state_hash, ledgerRange: [c1?.ledger_seq, c2?.ledger_seq], workspaceCommit: c2?.workspace_commit },
      { runId: RUN_ID, provider: fx.provider, budget: { runId: RUN_ID, capUsd: 0.25, spentUsd: 0 } },
    );
  });

  it('export of one checkpoint passes the SPEC-011 {run_id, checkpoint_id} target', async () => {
    const fx = fakeDeps(captureIo({ answers: ['y'] }));
    expect(await main(['export', REF_1], fx.deps)).toBe(0);
    expect(fx.modules.bundle.planExport).toHaveBeenCalledWith({ run_id: RUN_ID, checkpoint_id: 'c_1' }, { unsafe: false });
  });

  it('a command whose module rejects exits 1 with the error on stderr and still closes the store', async () => {
    const fx = fakeDeps();
    fx.modules.engine.diff.mockRejectedValueOnce(Object.assign(new Error('checkpoint c_2 not found'), { code: 'ERR_NOT_FOUND' }));
    expect(await main(['diff', REF_1, REF_2], fx.deps)).toBe(1);
    expect(fx.io.err).toBe('ckpt diff: ERR_NOT_FOUND: checkpoint c_2 not found\n');
    expect(fx.io.out).toBe('');
    expect(fx.modules.close).toHaveBeenCalledTimes(1);
  });

  it('run passes claude its exit code through', async () => {
    const fx = fakeDeps();
    fx.runner.run.mockResolvedValueOnce(130);
    expect(await main(['run', 'claude'], fx.deps)).toBe(130);
  });
});
