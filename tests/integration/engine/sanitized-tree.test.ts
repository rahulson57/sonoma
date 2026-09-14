/**
 * SPEC-003 / DEC-002 through the engine: a checkpoint commit is built only from a sanitized staging tree.
 * Secret paths never enter it, and no git object anywhere in the repository holds a corpus secret.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { isExcludedPath } from '../../../src/redact/index.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { engineFixture, gitBytes, treePaths, writeFiles } from './support.js';

function sample(kind: string): string {
  const found = secretCorpus().find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} sample in the corpus`);
  return found.value;
}

describe('sanitized staging tree', () => {
  it('a workspace containing .env and a file with a secretCorpus() value yields a checkpoint tree without .env and without the secret bytes', async () => {
    const corpus = secretCorpus();
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      const clean = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xc3, 0x28, 0x01, 0xfe]);
      const binaryWithSecret = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80]), Buffer.from(` token=${sample('github')} `), Buffer.from([0xc3, 0x28, 0x00])]);
      await writeFiles(fx.repo.dir, {
        '.env': `DATABASE_URL=${sample('db_url')}\nGITHUB_TOKEN=${sample('github')}\n`,
        'config/.env.production': `SLACK_TOKEN=${sample('slack')}\n`,
        'credentials.json': JSON.stringify({ key: sample('aws') }),
        'certs/server.pem': sample('pem'),
        'deploy/id.key': sample('pem'),
        'src/leaked.txt': corpus.map((entry, i) => `sample ${i} (${entry.kind}):\n${entry.value}\n`).join('\n'),
        'assets/blob.bin': binaryWithSecret,
        'assets/clean.bin': clean,
      });

      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const cp = await fx.engine.checkpoint(run.run_id);

      const paths = await treePaths(fx.repo.dir, cp.workspace_commit);
      expect(paths).toEqual(['README.md', 'assets/blob.bin', 'assets/clean.bin', 'src/leaked.txt']);
      expect(paths.filter((p) => isExcludedPath(p))).toEqual([]);

      const leaked = (await gitBytes(fx.repo.dir, ['show', `${cp.workspace_commit}:src/leaked.txt`])).toString('utf8');
      expect(leaked).toContain('[REDACTED:');
      expect(leaked).toContain('sample 0 (aws):');
      // Content without secrets is committed byte-identical, binary included.
      expect(await gitBytes(fx.repo.dir, ['show', `${cp.workspace_commit}:assets/clean.bin`])).toEqual(clean);
      expect((await gitBytes(fx.repo.dir, ['show', `${cp.workspace_commit}:assets/blob.bin`])).includes(Buffer.from(' token='))).toBe(true);

      // Byte scan of every object in the repository's object database.
      const objects = await gitBytes(fx.repo.dir, ['cat-file', '--batch-all-objects', '--batch']);
      expect(objects.byteLength).toBeGreaterThan(0);
      for (const { kind, value } of corpus) {
        expect(objects.includes(Buffer.from(value, 'utf8')), `a ${kind} corpus value is in a git object`).toBe(false);
      }
    } finally {
      await fx.cleanup();
    }
  });
});
