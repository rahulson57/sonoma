/**
 * SPEC-007 "must never send an unredacted blob to the provider" / SPEC-003: given secretCorpus() values
 * inside tool events (request, stdout, stderr, and a payload offloaded to CAS), the prompt captured by the
 * recorded provider contains none of them byte-for-byte.
 *
 * The events are appended to the store UNSANITIZED, on purpose. In the product the Checkpoint Engine
 * redacts before persistence. This test proves the distiller's own redaction layer holds even if an
 * unsanitized capture reached the ledger. Everything is written under the OS temp dir and removed.
 *
 * It also covers the other direction: text the provider writes back (claim values, cited workspace paths) is
 * sanitized before the projection's canonical JSON is written to CAS.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { DEFAULT_MODEL, SECRET_NAMED_VALUE, distill, distillRequestFor } from '../../../src/distill/index.js';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { openFixture } from './support.js';

const FILLER = 'lorem ipsum dolor sit amet\n'.repeat(Math.ceil(MAX_INLINE_PAYLOAD_BYTES / 27) + 1);

/** The CAS blob files under `objectsDir`, as paths relative to it. */
async function blobFiles(objectsDir: string): Promise<string[]> {
  const entries = await readdir(objectsDir, { recursive: true });
  return entries.filter((entry) => /^[0-9a-f]{64}$/.test(path.basename(entry)));
}

describe('no secret in the distiller prompt', () => {
  it('the captured provider prompt contains no secretCorpus() value', async () => {
    const fx = await openFixture();
    try {
      const corpus = secretCorpus();
      const c1 = await fx.checkpoint(null, { 'src/app.ts': 'export {};\n' });

      const citable: string[] = [];
      for (const [index, { kind, value }] of corpus.entries()) {
        const tool_call_id = `tool_${index}`;
        const requested = await fx.append('tool.requested', { tool_call_id, tool: 'Bash', input: { command: `deploy --token ${value}` } });
        const completed = await fx.append('tool.completed', {
          tool_call_id,
          exit_code: 0,
          stdout: `${kind} credential follows:\n${value}\ndone\n`,
          stderr: `warning: leaked ${value}`,
        });
        citable.push(requested.event_id, completed.event_id);
      }
      const offloaded = await fx.append('tool.completed', {
        tool_call_id: 'tool_big',
        exit_code: 0,
        stdout: `${FILLER}${corpus.map((secret) => secret.value).join('\n')}\n`,
      });
      expect(offloaded.payload).toBeNull();
      expect(offloaded.payload_ref).not.toBeNull();
      citable.push(offloaded.event_id);
      const c2 = await fx.checkpoint(c1, { 'src/app.ts': 'export const deployed = true;\n' }, 'handoff');

      const provider = await fx.provider(DEFAULT_MODEL, ['{"claims":[]}']);
      await distill(distillRequestFor(c2, c1), fx.deps(provider));

      expect(provider.prompts).toHaveLength(1);
      const prompt = provider.prompts[0]!;
      for (const { kind, value } of corpus) {
        expect(prompt.includes(value), `${kind} value reached the prompt`).toBe(false);
        // Also as it would appear inside a JSON string (a PEM block's newlines escaped).
        expect(prompt.includes(JSON.stringify(value).slice(1, -1)), `${kind} value reached the prompt JSON-escaped`).toBe(false);
      }
      expect(prompt).toContain('[REDACTED:');
      // Redaction removes the secrets, not the evidence: every event is still citable by id.
      for (const id of citable) expect(prompt).toContain(id);
    } finally {
      await fx.close();
    }
  });

  it('redacts low-entropy values held under secret-named payload keys, inline and offloaded to CAS', async () => {
    const fx = await openFixture();
    try {
      // No content detector flags these values; only the key names mark them as secrets.
      const named = { DB_PASSWORD: 'correct-horse-battery', GITHUB_TOKEN: 'abc123shortish', AWS_SECRET_ACCESS_KEY: 'plainwords' };
      const nestedValue = 'nested-plain-value';
      const c1 = await fx.checkpoint(null, { 'src/app.ts': 'export {};\n' });
      const topLevel = await fx.append('tool.completed', { tool_call_id: 'tool_top', exit_code: 0, DB_PASSWORD: named.DB_PASSWORD });
      const nested = await fx.append('tool.requested', { tool_call_id: 'tool_env', tool: 'Bash', input: { command: 'deploy' }, env: named });
      const offloaded = await fx.append('tool.completed', {
        tool_call_id: 'tool_env_big',
        exit_code: 0,
        stdout: FILLER,
        env: { ...named, config: { API_KEY: { value: nestedValue } } },
      });
      expect(offloaded.payload).toBeNull();
      expect(offloaded.payload_ref).not.toBeNull();
      const c2 = await fx.checkpoint(c1, { 'src/app.ts': 'export const deployed = true;\n' }, 'handoff');

      const provider = await fx.provider(DEFAULT_MODEL, ['{"claims":[]}']);
      await distill(distillRequestFor(c2, c1), fx.deps(provider));

      expect(provider.prompts).toHaveLength(1);
      const prompt = provider.prompts[0]!;
      for (const value of [...Object.values(named), nestedValue]) {
        expect(prompt.includes(value), `${value} reached the prompt`).toBe(false);
      }
      // The names and the evidence stay; only the values go.
      expect(prompt).toContain(`"DB_PASSWORD":"${SECRET_NAMED_VALUE}"`);
      expect(prompt).toContain(`"API_KEY":"${SECRET_NAMED_VALUE}"`);
      for (const id of [topLevel.event_id, nested.event_id, offloaded.event_id]) expect(prompt).toContain(id);
    } finally {
      await fx.close();
    }
  });

  it('sanitizes provider-authored claims before the projection is written to CAS', async () => {
    const fx = await openFixture();
    try {
      const corpus = secretCorpus();
      const c1 = await fx.checkpoint(null, { 'src/app.ts': 'export {};\n' });
      const changed = await fx.append('workspace.changed', { paths: ['src/app.ts'] });
      const c2 = await fx.checkpoint(c1, { 'src/app.ts': 'export const deployed = true;\n' }, 'handoff');

      const cite = { event_ids: [changed.event_id], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] };
      const claims = [
        // The model echoes or reconstructs a credential in its own text.
        ...corpus.map(({ kind, value }) => ({ field: 'current_state', value: `the ${kind} credential is ${value}`, provenance: cite })),
        // A cited path carrying a credential cannot be partly redacted: the claim is dropped.
        { field: 'plan', value: 'rotate the key', provenance: { ...cite, workspace_paths: [`keys/${corpus[0]!.value}.txt`] } },
      ];
      const provider = await fx.provider(DEFAULT_MODEL, [JSON.stringify({ claims })]);
      const objectsDir = fx.backend.layout.objects;
      const before = new Set(await blobFiles(objectsDir));

      const result = await distill(distillRequestFor(c2, c1), fx.deps(provider));

      expect(result.rejectedClaims).toBe(1);
      expect(result.projection.claims).toHaveLength(corpus.length);
      // The only CAS write of the distillation is the projection. Read its bytes straight from disk.
      const written = (await blobFiles(objectsDir)).filter((file) => !before.has(file));
      expect(written).toHaveLength(1);
      const bytes = await readFile(path.join(objectsDir, written[0]!), 'utf8');
      expect(JSON.parse(bytes)).toEqual(result.projection);
      for (const { kind, value } of corpus) {
        expect(bytes.includes(value), `${kind} value reached the stored projection`).toBe(false);
        expect(bytes.includes(JSON.stringify(value).slice(1, -1)), `${kind} value reached the stored projection JSON-escaped`).toBe(false);
      }
      expect(bytes).toContain('[REDACTED:');
      await expect(fx.store.get(result.projection.id)).resolves.toEqual(result.projection);
    } finally {
      await fx.close();
    }
  });
});
