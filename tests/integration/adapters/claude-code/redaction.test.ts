/**
 * SPEC-009 criterion: a PostToolUse payload containing a secret from secretCorpus() persists no raw secret bytes in
 * CAS, SQLite or git objects. The adapter hands tool I/O to the real engine raw; the engine's Redaction pass must be the
 * only thing between it and storage (SPEC-003).
 *
 * Every corpus value goes through the adapter in tool input, stdout, stderr, a prompt, a failure error and, for the
 * CAS path, a PostToolUse response over the 1 MB inline limit. The workspace file the Write creates holds a secret too,
 * and Stop and SessionEnd checkpoint it. Then CAS, checkpoint.db (with WAL), every git object in the repository and
 * every other byte under .ckpt/ are scanned.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../../src/ledger/ledger.js';
import { secretCorpus } from '../../../helpers/fakeSecrets.js';
import { allEvents, bytesUnder, git, gitBytes, writeFiles } from '../../engine/support.js';
import { adapterFixture, hookInput } from './support.js';

function sample(kind: string): string {
  const found = secretCorpus().find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} sample in the corpus`);
  return found.value;
}

/** Raw bytes of every object reachable from any ref (refs/checkpoints/* included). */
async function allGitObjects(repoDir: string): Promise<Buffer> {
  const ids = new Set(
    (await git(repoDir, ['rev-list', '--objects', '--all']))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split(' ')[0]!),
  );
  const chunks: Buffer[] = [];
  for (const id of ids) {
    const type = (await git(repoDir, ['cat-file', '-t', id])).trim();
    chunks.push(await gitBytes(repoDir, ['cat-file', type, id]));
  }
  return Buffer.concat(chunks);
}

async function checkpointDb(store: string): Promise<Buffer> {
  const parts = await Promise.all(
    ['checkpoint.db', 'checkpoint.db-wal', 'checkpoint.db-shm'].map((file) => readFile(path.join(store, file)).catch(() => Buffer.alloc(0))),
  );
  return Buffer.concat(parts);
}

describe('adapter observations are redacted before they persist', () => {
  it('a PostToolUse carrying every secretCorpus() value leaves no raw secret bytes in CAS, SQLite or git objects', async () => {
    const corpus = secretCorpus();
    const everySecret = corpus.map((entry, i) => `sample ${i} (${entry.kind}): ${entry.value}`).join('\n');
    const fx = await adapterFixture();
    try {
      const h = fx.handler;
      const bash = 'toolu_01RedactBashAaBbCcDdEeF';
      const bashInput = { command: `curl -H "Authorization: token ${sample('github')}" https://example.invalid && echo ${sample('aws')}` };

      await h.handleHook(hookInput('SessionStart', { source: 'startup' }));
      await h.handleHook(hookInput('UserPromptSubmit', { prompt: `use this key: ${sample('slack')}` }));
      await h.handleHook(hookInput('PreToolUse', { tool_name: 'Bash', tool_input: bashInput, tool_use_id: bash }));
      await h.handleHook(
        hookInput('PostToolUse', {
          tool_name: 'Bash',
          tool_input: bashInput,
          tool_response: { stdout: everySecret, stderr: `warning: ${sample('slack')}\n${sample('pem')}`, interrupted: false },
          tool_use_id: bash,
        }),
      );

      // Over the inline limit: the response is offloaded to CAS, which must hold only redacted bytes.
      const read = 'toolu_01RedactReadAaBbCcDdEeF';
      await h.handleHook(hookInput('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'server.log' }, tool_use_id: read }));
      await h.handleHook(
        hookInput('PostToolUse', {
          tool_name: 'Read',
          tool_input: { file_path: 'server.log' },
          tool_response: { type: 'text', file: { content: `${'log line\n'.repeat(Math.ceil(MAX_INLINE_PAYLOAD_BYTES / 9))}${everySecret}` } },
          tool_use_id: read,
        }),
      );

      // A Write whose file carries a secret, so the checkpoint tree has something to redact too.
      const write = 'toolu_01RedactWriteAaBbCcDdEe';
      const content = `export const settings = {\n${corpus.map((entry) => `  ${entry.kind}: ${JSON.stringify(entry.value)},`).join('\n')}\n};\n`;
      const writeInput = { file_path: 'config/settings.ts', content };
      await h.handleHook(hookInput('PreToolUse', { tool_name: 'Write', tool_input: writeInput, tool_use_id: write }));
      await writeFiles(fx.repo.dir, { 'config/settings.ts': content });
      await h.handleHook(hookInput('PostToolUse', { tool_name: 'Write', tool_input: writeInput, tool_response: { success: true, content }, tool_use_id: write }));

      await h.handleHook(hookInput('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'toolu_01RedactFailAaBbCcDdEeF', error: `auth failed for ${sample('db_url')} with ${sample('jwt')}` }));
      await h.handleHook(hookInput('Stop', { stop_hook_active: false }));
      await h.handleHook(hookInput('SessionEnd', { reason: 'other' }));

      const ledger = await allEvents(fx.backend, fx.run.run_id);
      expect(ledger.some((event) => event.type === 'tool.completed' && event.payload_ref !== null)).toBe(true);
      expect(ledger.filter((event) => event.type === 'checkpoint.created')).toHaveLength(2);
      expect(ledger.filter((event) => event.type === 'adapter.error')).toEqual([]);
      // Redaction happened (markers present), rather than the secrets never having been sent.
      expect(JSON.stringify(ledger)).toContain('[REDACTED:');

      const store = path.join(fx.repo.dir, '.ckpt');
      const scan = async (): Promise<Record<string, Buffer>> => ({
        CAS: await bytesUnder(path.join(store, 'objects')),
        SQLite: await checkpointDb(store),
        'git objects': await allGitObjects(fx.repo.dir),
        '.ckpt/': await bytesUnder(store),
        'ledger read back': Buffer.from(JSON.stringify(ledger)),
      });
      const expectClean = (scanned: Record<string, Buffer>): void => {
        expect(scanned['CAS']!.byteLength).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES);
        expect(scanned['SQLite']!.byteLength).toBeGreaterThan(0);
        expect(scanned['git objects']!.byteLength).toBeGreaterThan(0);
        for (const [where, bytes] of Object.entries(scanned)) {
          for (const { kind, value } of corpus) {
            expect(bytes.includes(Buffer.from(value, 'utf8')), `a raw ${kind} secret is in ${where}`).toBe(false);
          }
        }
      };

      expectClean(await scan());
      await fx.backend.close();
      expectClean(await scan());
    } finally {
      await fx.cleanup();
    }
  });
});
