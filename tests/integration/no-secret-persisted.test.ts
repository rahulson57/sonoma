/**
 * SPEC-003 / DEC-007 / SPEC-015 amendment 7: the store never persists a secret. After real checkpoints of a
 * secret-bearing workspace and secret-bearing tool I/O (inline and offloaded to CAS), a byte scan of CAS,
 * checkpoint.db (with its WAL) and every git object reachable from refs/checkpoints/* finds zero secretCorpus()
 * values, and .ckpt/ is mode 0700 with every file under it 0600.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { MAX_INLINE_PAYLOAD_BYTES } from '../../src/ledger/ledger.js';
import { secretCorpus } from '../helpers/fakeSecrets.js';
import { allEvents, bytesUnder, engineFixture, git, gitBytes, writeFiles } from './engine/support.js';
import { walkTree } from './storage/support.js';

function sample(kind: string): string {
  const found = secretCorpus().find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} sample in the corpus`);
  return found.value;
}

/** Raw bytes of every git object reachable from refs/checkpoints/*. */
async function checkpointObjects(repoDir: string): Promise<{ refs: string[]; bytes: Buffer }> {
  const refs = (await git(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/checkpoints'])).split('\n').filter((line) => line !== '');
  const ids = new Set(
    (await git(repoDir, ['rev-list', '--objects', ...refs]))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split(' ')[0]!),
  );
  const chunks: Buffer[] = [];
  for (const id of ids) {
    const type = (await git(repoDir, ['cat-file', '-t', id])).trim();
    chunks.push(await gitBytes(repoDir, ['cat-file', type, id]));
  }
  return { refs, bytes: Buffer.concat(chunks) };
}

async function checkpointDb(store: string): Promise<Buffer> {
  const parts = await Promise.all(
    ['checkpoint.db', 'checkpoint.db-wal', 'checkpoint.db-shm'].map((file) => readFile(path.join(store, file)).catch(() => Buffer.alloc(0))),
  );
  return Buffer.concat(parts);
}

function permissionViolations(entries: ReadonlyArray<{ rel: string; mode: number; isDirectory: boolean }>): string[] {
  return entries.filter((entry) => entry.mode !== (entry.isDirectory ? 0o700 : 0o600)).map((entry) => `${entry.rel} ${entry.mode.toString(8)}`);
}

describe('no secret is persisted', () => {
  it('a byte scan of CAS, checkpoint.db and refs/checkpoints/* finds zero secretCorpus() values, and .ckpt/ is 0700 with files 0600', async () => {
    const corpus = secretCorpus();
    const everySecret = corpus.map((entry, i) => `sample ${i} (${entry.kind}): ${entry.value}`).join('\n');
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      await writeFiles(fx.repo.dir, {
        '.env': `GITHUB_TOKEN=${sample('github')}\n`,
        'credentials.json': JSON.stringify({ aws: sample('aws') }),
        'config/settings.ts': `export const settings = {\n${corpus.map((entry) => `  ${entry.kind}: ${JSON.stringify(entry.value)},`).join('\n')}\n};\n`,
        'assets/firmware.bin': Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(sample('aws')), Buffer.from([0xc3, 0x28])]),
        'assets/logo.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      });

      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const recorded = await fx.engine.record([
        {
          run_id: run.run_id,
          type: 'tool.requested',
          actor: 'agent',
          payload: { tool_call_id: 'call_1', tool: 'Bash', input: { command: `curl -H "Authorization: token ${sample('github')}" https://example.invalid` } },
        },
        { run_id: run.run_id, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_1', stdout: everySecret, stderr: `warning: ${sample('slack')}` } },
        { run_id: run.run_id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_2', tool: 'Read' } },
        {
          run_id: run.run_id,
          type: 'tool.completed',
          actor: 'runtime',
          payload: { tool_call_id: 'call_2', stdout: `${'log line\n'.repeat(Math.ceil(MAX_INLINE_PAYLOAD_BYTES / 9))}${everySecret}` },
        },
      ]);
      // The large result really went to CAS.
      expect(recorded.some((event) => event.payload_ref !== null)).toBe(true);
      const c1 = await fx.engine.checkpoint(run.run_id);

      fx.clock.tick(2000);
      await writeFiles(fx.repo.dir, { 'config/settings.ts': `export const token = ${JSON.stringify(sample('jwt'))};\n` });
      const c2 = await fx.engine.checkpoint(run.run_id);
      expect(c2.parent_checkpoint_id).toBe(c1.checkpoint_id);
      expect((await allEvents(fx.backend, run.run_id)).some((event) => event.type === 'workspace.file_skipped')).toBe(true);

      const store = path.join(fx.repo.dir, '.ckpt');
      const scan = async (): Promise<Record<string, Buffer>> => {
        const objects = await checkpointObjects(fx.repo.dir);
        expect(objects.refs).toHaveLength(2);
        return {
          CAS: await bytesUnder(path.join(store, 'objects')),
          'checkpoint.db': await checkpointDb(store),
          'refs/checkpoints/*': objects.bytes,
          // Everything else under .ckpt/ (run records, the ledger log, locks) as well.
          '.ckpt/': await bytesUnder(store),
        };
      };
      const expectClean = (scanned: Record<string, Buffer>): void => {
        expect(scanned['CAS']!.byteLength).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES);
        expect(scanned['checkpoint.db']!.byteLength).toBeGreaterThan(0);
        expect(scanned['refs/checkpoints/*']!.byteLength).toBeGreaterThan(0);
        for (const [where, bytes] of Object.entries(scanned)) {
          for (const { kind, value } of corpus) {
            expect(bytes.includes(Buffer.from(value, 'utf8')), `a ${kind} corpus value is in ${where}`).toBe(false);
          }
        }
      };

      // While the store is open (WAL present)…
      expectClean(await scan());
      const open = await walkTree(store);
      expect(open[0]).toEqual({ rel: '.', mode: 0o700, isDirectory: true });
      expect(permissionViolations(open)).toEqual([]);

      // …and after close, once the WAL is folded into checkpoint.db.
      await fx.backend.close();
      expectClean(await scan());
      expect(permissionViolations(await walkTree(store))).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });
});
