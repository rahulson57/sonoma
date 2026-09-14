/**
 * SPEC-013 "Must never suppress rollback side-effect warnings" and "A rollback with side-effect warnings still exits 0".
 * Three irreversible side effects are recorded after c_1 through the real Checkpoint Engine. `ckpt rollback` to c_1 prints
 * all three on stderr and exits 0.
 */
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { main } from '../../../src/cli/index.js';
import { captureIo } from '../../unit/cli/support.js';
import { cliStore, irreversibleSideEffect } from './support.js';

const EFFECTS = [
  { id: 'se_email', type: 'email.send', target: 'ops@example.invalid' },
  { id: 'se_payment', type: 'payment.charge', target: 'acct_fixture_0001' },
  { id: 'se_deploy', type: 'deploy.release', target: 'prod.example.invalid' },
] as const;

describe('ckpt rollback warnings (SPEC-013)', () => {
  it('prints all 3 irreversible side-effect warnings on stderr and exits 0', async () => {
    const store = await cliStore(async ({ engine, runId, write }) => {
      await engine.checkpoint(runId);
      for (const effect of EFFECTS) await engine.record(irreversibleSideEffect(runId, effect.id, effect.type, effect.target));
      await write('app.txt', 'v2\n');
      await engine.checkpoint(runId);
    });
    try {
      const io = captureIo({ cwd: store.repo.dir });

      const code = await main(['rollback', `${store.runId}:c_1`], { io });

      expect(code).toBe(0);
      const warnings = io.err.split('\n').filter((line) => line.startsWith('warning:'));
      expect(warnings).toEqual(EFFECTS.map((effect) => `warning: side effect not undone by rollback: ${effect.type} ${effect.target} (irreversible)`));
      expect(io.out).toContain(`Rolled back to ${store.runId}:c_1`);
      expect(io.out).toContain('3 side effect warning(s)');
      expect(io.out).not.toContain('warning:');
    } finally {
      await store.cleanup();
    }
  });
});
