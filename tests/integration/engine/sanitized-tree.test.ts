/**
 * SPEC-003 / SPEC-006 / DEC-002 / DEC-037 (SPEC-015 amendment 6) through the engine: a checkpoint commit is built
 * only from a sanitized staging tree. Secret paths never enter it; text is redacted in place; a non-UTF-8 file in
 * which the scanner finds a secret is SKIPPED with exactly one `workspace.file_skipped` event; a clean binary is
 * committed byte-identical; and no git object anywhere in the repository holds a corpus secret.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import type { LedgerEvent } from '../../../src/model/types.js';
import { isExcludedPath } from '../../../src/redact/index.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { allEvents, engineFixture, gitBytes, treePaths, writeFiles } from './support.js';

function sample(kind: string): string {
  const found = secretCorpus().find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} sample in the corpus`);
  return found.value;
}

/** A non-UTF-8 buffer with `secret` embedded between invalid UTF-8 sequences. */
function binaryWith(secret: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80]), Buffer.from(` token=${secret} `), Buffer.from([0xc3, 0x28, 0x00])]);
}

function skippedIn(events: readonly LedgerEvent[], fromSeqExclusive: number, toSeqInclusive: number): LedgerEvent[] {
  return events.filter((event) => event.type === 'workspace.file_skipped' && event.seq > fromSeqExclusive && event.seq <= toSeqInclusive);
}

async function expectNoCorpusInGitObjects(repoDir: string): Promise<void> {
  const objects = await gitBytes(repoDir, ['cat-file', '--batch-all-objects', '--batch']);
  expect(objects.byteLength).toBeGreaterThan(0);
  for (const { kind, value } of secretCorpus()) {
    expect(objects.includes(Buffer.from(value, 'utf8')), `a ${kind} corpus value is in a git object`).toBe(false);
  }
}

describe('sanitized staging tree', () => {
  it('a workspace containing .env and a file with a secretCorpus() value yields a checkpoint tree without .env and without the secret bytes', async () => {
    const corpus = secretCorpus();
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      await writeFiles(fx.repo.dir, {
        '.env': `DATABASE_URL=${sample('db_url')}\nGITHUB_TOKEN=${sample('github')}\n`,
        'config/.env.production': `SLACK_TOKEN=${sample('slack')}\n`,
        'credentials.json': JSON.stringify({ key: sample('aws') }),
        'certs/server.pem': sample('pem'),
        'deploy/id.key': sample('pem'),
        'src/leaked.txt': corpus.map((entry, i) => `sample ${i} (${entry.kind}):\n${entry.value}\n`).join('\n'),
      });

      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const cp = await fx.engine.checkpoint(run.run_id);

      const paths = await treePaths(fx.repo.dir, cp.workspace_commit);
      expect(paths).toEqual(['README.md', 'src/leaked.txt']);
      expect(paths.filter((p) => isExcludedPath(p))).toEqual([]);

      // Text keeps in-place redaction.
      const leaked = (await gitBytes(fx.repo.dir, ['show', `${cp.workspace_commit}:src/leaked.txt`])).toString('utf8');
      expect(leaked).toContain('[REDACTED:');
      expect(leaked).toContain('sample 0 (aws):');
      expect(skippedIn(await allEvents(fx.backend, run.run_id), 0, cp.ledger_seq)).toEqual([]);

      await expectNoCorpusInGitObjects(fx.repo.dir);
    } finally {
      await fx.cleanup();
    }
  });

  it('a non-UTF-8 file containing a secretCorpus() value is absent from the checkpoint tree with exactly one workspace.file_skipped event, and a clean binary is committed byte-identical', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      const clean = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xc3, 0x28, 0x01, 0xfe]);
      const secretBinary = binaryWith(sample('github'));
      await writeFiles(fx.repo.dir, { 'assets/blob.bin': secretBinary, 'assets/clean.bin': clean });

      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const cp = await fx.engine.checkpoint(run.run_id);

      expect(await treePaths(fx.repo.dir, cp.workspace_commit)).toEqual(['README.md', 'assets/clean.bin']);
      expect(await gitBytes(fx.repo.dir, ['show', `${cp.workspace_commit}:assets/clean.bin`])).toEqual(clean);

      const events = await allEvents(fx.backend, run.run_id);
      const skipped = events.filter((event) => event.type === 'workspace.file_skipped');
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.seq).toBeLessThan(cp.ledger_seq);
      expect(skipped[0]!.payload).toMatchObject({ path: 'assets/blob.bin', size: secretBinary.byteLength, reason: 'secret_detected' });
      // The event names the file; it does not carry its content.
      expect(JSON.stringify(skipped[0]!.payload)).not.toContain(sample('github'));

      await expectNoCorpusInGitObjects(fx.repo.dir);
    } finally {
      await fx.cleanup();
    }
  });

  it('a clean binary that later gains a secret leaves the next checkpoint tree, with exactly one workspace.file_skipped event for it', async () => {
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      const firmware = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0xff, 0xfe]);
      await writeFiles(fx.repo.dir, { 'bin/firmware.img': firmware, 'src/app.ts': 'export {};\n' });
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const c1 = await fx.engine.checkpoint(run.run_id);
      expect(await treePaths(fx.repo.dir, c1.workspace_commit)).toEqual(['README.md', 'bin/firmware.img', 'src/app.ts']);

      fx.clock.tick(2000);
      await writeFiles(fx.repo.dir, { 'bin/firmware.img': Buffer.concat([firmware, binaryWith(sample('aws'))]), 'src/app.ts': 'export const x = 1;\n' });
      const c2 = await fx.engine.checkpoint(run.run_id);

      expect(await treePaths(fx.repo.dir, c2.workspace_commit)).toEqual(['README.md', 'src/app.ts']);
      // History is not rewritten: the clean version stays in c1, byte-identical.
      expect(await gitBytes(fx.repo.dir, ['show', `${c1.workspace_commit}:bin/firmware.img`])).toEqual(firmware);
      const skipped = skippedIn(await allEvents(fx.backend, run.run_id), c1.ledger_seq, c2.ledger_seq);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.payload).toMatchObject({ path: 'bin/firmware.img', reason: 'secret_detected' });

      await expectNoCorpusInGitObjects(fx.repo.dir);
    } finally {
      await fx.cleanup();
    }
  });
});
