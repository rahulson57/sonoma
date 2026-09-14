/**
 * SPEC-010 "Must never persist declared strings before the Engine's Redaction pass" / SPEC-003: secrets declared
 * through save() leave no raw bytes in CAS, SQLite, git objects or anywhere else under .ckpt/.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { createCkpt } from '../../../src/sdk/index.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { engineFixture } from '../engine/support.js';
import { storeBytes } from './support.js';

/** Plain text that survives redaction, proving the declared text really is in the bytes scanned. */
const MARKER = 'sdk-declared-probe';

function sample(kind: string): string {
  const found = secretCorpus().find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} sample in the corpus`);
  return found.value;
}

describe('save() redaction', () => {
  it('a declared string containing a secret from secretCorpus() persists no raw secret bytes in CAS, SQLite or git objects', async () => {
    const corpus = secretCorpus();
    const fx = await engineFixture({ files: { 'README.md': '# app\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'sdk' });
      const ckpt = createCkpt({ engine: fx.engine, runId: run.run_id });
      const ref = await ckpt.save(
        {
          goal: `${MARKER} goal: deploy with token ${sample('github')}`,
          current_step: `${MARKER} step: posting to ${sample('slack')}`,
          next_action: `${MARKER} next: call the API with ${sample('jwt')}`,
          decisions: corpus.map((s, i) => `${MARKER} decision ${i} (${s.kind}): ${s.value}`),
          assumptions: corpus.map((s, i) => `${MARKER} assumption ${i}: ${s.value} stays valid`),
        },
        { label: `${MARKER} label ${sample('aws')}` },
      );

      const claims = await fx.backend.listClaims({ runId: ref.runId, checkpointId: ref.checkpointId });
      expect(claims).toHaveLength(3 + 2 * corpus.length);
      for (const c of claims) {
        expect(c.origin).toBe('agent_declared');
        expect(c.value).toContain(MARKER);
      }

      const expectClean = (scanned: Record<string, Buffer>): void => {
        // Non-vacuous: the declaration reached the projection blob in CAS and the ledger under .ckpt/.
        expect(scanned['CAS']!.includes(MARKER)).toBe(true);
        expect(scanned['.ckpt/']!.includes(`${MARKER} decision 0`)).toBe(true);
        expect(scanned['checkpoint.db']!.byteLength).toBeGreaterThan(0);
        expect(scanned['refs/checkpoints/*']!.byteLength).toBeGreaterThan(0);
        for (const [where, bytes] of Object.entries(scanned)) {
          for (const { kind, value } of corpus) {
            expect(bytes.includes(Buffer.from(value, 'utf8')), `a ${kind} corpus value is in ${where}`).toBe(false);
          }
        }
      };

      // While the store is open (WAL present)…
      expectClean(await storeBytes(fx.repo.dir));
      // …and after close, once the WAL is folded into checkpoint.db.
      await fx.backend.close();
      expectClean(await storeBytes(fx.repo.dir));
    } finally {
      await fx.cleanup();
    }
  });
});
