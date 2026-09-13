/**
 * SPEC-007 "must never send an unredacted blob to the provider" / SPEC-003: given secretCorpus() values
 * inside tool events (request, stdout, stderr, and a payload offloaded to CAS), the prompt captured by the
 * recorded provider contains none of them byte-for-byte.
 *
 * The events are appended to the store UNSANITIZED, on purpose. In the product the Checkpoint Engine
 * redacts before persistence. This test proves the distiller's own redaction layer holds even if an
 * unsanitized capture reached the ledger. Everything is written under the OS temp dir and removed.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { DEFAULT_MODEL, distill, distillRequestFor } from '../../../src/distill/index.js';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { openFixture } from './support.js';

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
      const filler = 'lorem ipsum dolor sit amet\n'.repeat(Math.ceil(MAX_INLINE_PAYLOAD_BYTES / 27) + 1);
      const offloaded = await fx.append('tool.completed', {
        tool_call_id: 'tool_big',
        exit_code: 0,
        stdout: `${filler}${corpus.map((secret) => secret.value).join('\n')}\n`,
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
});
