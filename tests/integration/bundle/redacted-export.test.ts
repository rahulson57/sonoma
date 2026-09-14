/**
 * SPEC-011 / SPEC-003 "Export": a run seeded with secretCorpus() in every place a bundle carries content
 * exports a tar holding zero raw secret bytes.
 */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { answering, checkpoint, event, openStore, type Store } from '../../unit/bundle/fixtures.js';

/** Every byte form a corpus value can take in the bundle: raw, JSON-escaped, and each PEM body line. */
function needles(value: string): string[] {
  const forms = new Set([value, JSON.stringify(value).slice(1, -1)]);
  for (const line of value.split('\n')) {
    if (/^[A-Za-z0-9+/=]{40,}$/.test(line)) forms.add(line);
  }
  return [...forms];
}

describe('redacted export', () => {
  let store: Store;

  beforeEach(async () => {
    store = await openStore();
  });

  afterEach(async () => {
    await store.cleanup();
  });

  it('a run seeded with secretCorpus() exports a bundle containing zero raw secret bytes', async () => {
    const corpus = secretCorpus();
    const all = corpus.map((sample) => sample.value).join('\n\n');
    const byKind = (kind: string): string => corpus.find((sample) => sample.kind === kind)!.value;

    const run = await store.backend.createRun({ agent: `claude-code ${byKind('slack')}` });
    const runId = run.run_id;
    // Tool request, stdout and stderr.
    await event(store, runId, 'tool.requested', { tool: 'bash', command: `curl -H "Authorization: Bearer ${byKind('jwt')}" ${byKind('db_url')}` });
    await event(store, runId, 'tool.completed', { stdout: all, stderr: `warning: ${byKind('aws')}\n` });
    // An over-limit payload (stored as a CAS payload blob) and an artifact blob.
    await event(store, runId, 'tool.completed', { stdout: `${'lorem ipsum dolor '.repeat(70_000)}\n${all}\n`, stderr: '' });
    const artifact = await store.backend.putBlob(Buffer.from(`artifact dump\n${all}\n`, 'utf8'));
    await event(store, runId, 'tool.completed', { stdout: 'saved', stderr: '', output: artifact });
    // Workspace files in two checkpoints, and a checkpoint label.
    const first = await checkpoint(store, runId, null, { 'config/settings.txt': `${all}\n`, 'src/app.ts': 'export const ok = true;\n' });
    await checkpoint(store, runId, first.checkpoint_id, { 'config/settings.txt': `rotated\n${byKind('github')}\n`, 'notes/keys.md': all }, `label ${byKind('aws')}`);

    const result = await store.service.exportBundle(runId, {}, answering('y'));
    expect(result.status).toBe('written');
    for (const kind of ['aws', 'github', 'slack', 'jwt', 'pem', 'db_url', 'high_entropy']) {
      expect(result.report.hits.some((hit) => hit.kind === kind), kind).toBe(true);
    }

    const tar = await readFile(result.bundlePath!);
    const leaks: string[] = [];
    for (const sample of corpus) {
      for (const needle of needles(sample.value)) {
        if (tar.includes(needle)) leaks.push(`${sample.kind}: ${needle.slice(0, 12)}…`);
      }
    }
    expect(leaks).toEqual([]);
    expect(tar.includes('[REDACTED:')).toBe(true);
  });
});
