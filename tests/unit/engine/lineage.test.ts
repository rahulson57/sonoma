/**
 * DEC-024: engine-authored lineage payloads skip sanitize() only because they are validated against an exact
 * per-event-type schema BEFORE anything is written; caller-supplied strings (the run's agent name) are
 * sanitized before storage sees them.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
import { CheckpointEngine, LINEAGE_SCHEMAS, isEngineError, lineagePayload, type LineageEventType } from '../../../src/engine/index.js';
import type { Checkpoint } from '../../../src/model/types.js';
import type { LocalBackend } from '../../../src/storage/index.js';
import type { StorageBackend } from '../../../src/storage/types.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { allEvents, bytesUnder, engineFixture, refOf } from '../../integration/engine/support.js';

const RUN_ID = 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

const VALID: Record<LineageEventType, Record<string, string | number>> = {
  'agent.resumed': { checkpoint_id: 'c_3', ledger_seq: 7, workspace_commit: SHA1 },
  'agent.rolled_back': { checkpoint_id: 'c_3', ledger_seq: 7, workspace_commit: SHA1, side_effect_warnings: 2 },
  'agent.forked': { parent_run_id: RUN_ID, forked_from_checkpoint: 'c_3', ledger_seq: 7, workspace_commit: SHA1 },
};
const TYPES = Object.keys(VALID) as LineageEventType[];

/** Asserts `fn` throws ERR_CORRUPT without echoing `secret` in the message. */
function expectRejected(fn: () => unknown, secret?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(isEngineError(caught, 'ERR_CORRUPT'), `expected ERR_CORRUPT, got ${String(caught)}`).toBe(true);
  if (secret !== undefined) expect((caught as Error).message.includes(secret)).toBe(false);
}

describe('lineagePayload (DEC-024(a))', () => {
  it('accepts exactly each schema and returns a fresh copy of it', () => {
    expect(Object.keys(LINEAGE_SCHEMAS).sort()).toEqual([...TYPES].sort());
    for (const type of TYPES) {
      const out = lineagePayload(type, VALID[type], 'sha1');
      expect(out).toEqual(VALID[type]);
      expect(out).not.toBe(VALID[type]);
    }
    expect(lineagePayload('agent.resumed', { ...VALID['agent.resumed'], workspace_commit: SHA256 }, 'sha256')).toMatchObject({ workspace_commit: SHA256 });
  });

  it('rejects an unexpected key, including a free-text or secret-named one, and a missing key', () => {
    for (const type of TYPES) {
      expectRejected(() => lineagePayload(type, { ...VALID[type], note: 'resumed after a crash' }, 'sha1'));
      expectRejected(() => lineagePayload(type, { ...VALID[type], [Symbol('x')]: 1 }, 'sha1'));
      for (const { value } of secretCorpus()) {
        expectRejected(() => lineagePayload(type, { ...VALID[type], [value]: 1 }, 'sha1'), value);
      }
      for (const key of Object.keys(VALID[type])) {
        const missing = { ...VALID[type] };
        delete missing[key];
        expectRejected(() => lineagePayload(type, missing, 'sha1'));
      }
    }
  });

  it('checks every field against its OWN pattern, not the union of identifier patterns', () => {
    const swaps: Array<[LineageEventType, string, unknown]> = [
      ['agent.resumed', 'checkpoint_id', SHA1],
      ['agent.resumed', 'checkpoint_id', RUN_ID],
      ['agent.resumed', 'workspace_commit', RUN_ID],
      ['agent.resumed', 'workspace_commit', 'c_3'],
      ['agent.resumed', 'workspace_commit', SHA256], // wrong length for a sha1 repository
      ['agent.resumed', 'workspace_commit', SHA1.toUpperCase()],
      ['agent.resumed', 'ledger_seq', -1],
      ['agent.resumed', 'ledger_seq', 1.5],
      ['agent.resumed', 'ledger_seq', '7'],
      ['agent.rolled_back', 'side_effect_warnings', Number.NaN],
      ['agent.rolled_back', 'side_effect_warnings', '2'],
      ['agent.forked', 'parent_run_id', 'c_3'],
      ['agent.forked', 'parent_run_id', SHA1],
      ['agent.forked', 'forked_from_checkpoint', RUN_ID],
      ['agent.forked', 'ledger_seq', null],
    ];
    for (const [type, key, value] of swaps) {
      expectRejected(() => lineagePayload(type, { ...VALID[type], [key]: value }, 'sha1'));
    }
    expectRejected(() => lineagePayload('agent.resumed', { ...VALID['agent.resumed'] }, 'sha256'));
  });

  it('rejects a secretCorpus() value in every string field without echoing it', () => {
    const corpus = secretCorpus();
    for (const type of TYPES) {
      for (const [key, value] of Object.entries(VALID[type])) {
        if (typeof value !== 'string') continue;
        for (const { value: secret } of corpus) {
          expectRejected(() => lineagePayload(type, { ...VALID[type], [key]: secret }, 'sha1'), secret);
          // In a sha256 repository a 64-lowercase-hex value is structurally a commit id (DEC-024(a) admits
          // sha256 hashes); the engine only appends such a payload after git has checked that commit out.
          if (key === 'workspace_commit' && /^[0-9a-f]{64}$/.test(secret)) continue;
          expectRejected(() => lineagePayload(type, { ...VALID[type], [key]: secret }, 'sha256'), secret);
        }
      }
    }
  });

  it('rejects an unknown event type and a payload that is not a plain object', () => {
    expectRejected(() => lineagePayload('run.created' as LineageEventType, { agent: 'x' }, 'sha1'));
    expectRejected(() => lineagePayload('agent.resumed', null, 'sha1'));
    expectRejected(() => lineagePayload('agent.resumed', [VALID['agent.resumed']], 'sha1'));
    expectRejected(() => lineagePayload('agent.resumed', Object.assign(Object.create(null) as object, VALID['agent.resumed']), 'sha1'));
    const withGetter = { ...VALID['agent.resumed'] };
    Object.defineProperty(withGetter, 'ledger_seq', { get: () => 7, enumerable: true });
    expectRejected(() => lineagePayload('agent.resumed', withGetter, 'sha1'));
  });
});

const WRITE_METHODS: ReadonlySet<string> = new Set(['appendEvent', 'createRun', 'fork', 'createCheckpoint']);

/** The real backend, with `getCheckpoint` results passed through `tamper` and every write method call recorded. */
function spyBackend(real: LocalBackend, tamper: (checkpoint: Checkpoint) => Checkpoint): { backend: StorageBackend; writes: string[] } {
  const writes: string[] = [];
  const backend = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'getCheckpoint') {
        return async (...args: unknown[]) => tamper((await method.apply(target, args)) as Checkpoint);
      }
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          writes.push(prop);
          return method.apply(target, args);
        };
      }
      return method.bind(target);
    },
  });
  return { backend, writes };
}

describe('lineage validation happens before any write (DEC-024(d))', () => {
  it('a secret in a lineage field is rejected before any append, forked run or worktree write', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const c1 = await fx.engine.checkpoint(run.run_id);
      const runsDir = path.join(fx.repo.dir, '.ckpt', 'runs');
      const eventsBefore = await allEvents(fx.backend, run.run_id);
      const runsBefore = (await readdir(runsDir)).sort();

      for (const field of ['workspace_commit', 'checkpoint_id'] as const) {
        for (const { kind, value } of secretCorpus()) {
          const { backend, writes } = spyBackend(fx.backend, (checkpoint) => ({ ...checkpoint, [field]: value }));
          const engine = await CheckpointEngine.open({ backend, repoDir: fx.repo.dir });
          for (const [name, operation] of [
            ['resume', () => engine.resume(refOf(c1))],
            ['rollback', () => engine.rollback(refOf(c1))],
            ['fork', () => engine.fork(refOf(c1))],
          ] as const) {
            const err: unknown = await operation().then(
              () => undefined,
              (thrown: unknown) => thrown,
            );
            expect(isEngineError(err, 'ERR_CORRUPT'), `${name} with a ${kind} ${field}: ${String(err)}`).toBe(true);
            expect((err as Error).message.includes(value)).toBe(false);
          }
          expect(writes, `${kind} in ${field}`).toEqual([]);
        }
      }

      // Nothing was appended, no run was forked, no execution worktree was created.
      expect(await allEvents(fx.backend, run.run_id)).toEqual(eventsBefore);
      expect((await readdir(runsDir)).sort()).toEqual(runsBefore);
      await expect(stat(fx.engine.worktreePath(run.run_id))).rejects.toMatchObject({ code: 'ENOENT' });

      // Control: the same spy with nothing tampered lets the append through, so the assertions above are not vacuous.
      const { backend, writes } = spyBackend(fx.backend, (checkpoint) => checkpoint);
      const engine = await CheckpointEngine.open({ backend, repoDir: fx.repo.dir });
      await engine.resume(refOf(c1));
      expect(writes).toEqual(['appendEvent']);
      expect((await allEvents(fx.backend, run.run_id)).at(-1)?.type).toBe('agent.resumed');
    } finally {
      await fx.cleanup();
    }
  });

  it('a secretCorpus() agent name never reaches the store, the returned Run, run.created or a forked Run', async () => {
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    const corpus = secretCorpus();
    try {
      for (const { kind, value } of corpus) {
        const run = await fx.engine.startRun({ agent: `claude-code ${value}` });
        expect(run.agent.includes(value), `${kind} in Run.agent`).toBe(false);
        expect(run.agent).toContain('[REDACTED:');
        const created = (await allEvents(fx.backend, run.run_id))[0];
        expect(created?.type).toBe('run.created');
        expect(JSON.stringify(created?.payload).includes(value), `${kind} in run.created`).toBe(false);

        const checkpoint = await fx.engine.checkpoint(run.run_id);
        const forked = await fx.engine.fork(refOf(checkpoint));
        expect(forked.agent.includes(value), `${kind} in the forked Run.agent`).toBe(false);
        expect(forked.agent).toBe(run.agent);
      }
      const stored = await bytesUnder(path.join(fx.repo.dir, '.ckpt'));
      for (const { kind, value } of corpus) {
        expect(stored.includes(Buffer.from(value, 'utf8')), `a ${kind} agent name is in .ckpt/`).toBe(false);
      }
    } finally {
      await fx.cleanup();
    }
  });
});
