import { describe, expect, it } from 'vitest';
import { validateAgainst } from '../../../src/model/schemas.js';
import { CLAIM_ORIGINS, SEMANTIC_FIELDS } from '../../../src/model/types.js';
import { validateSemanticClaim, validateSemanticProjection } from '../../../src/model/validate.js';

const EMPTY_PROVENANCE = { event_ids: [], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] };

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    field: 'goal',
    value: 'Land the canonical model',
    origin: 'agent_declared',
    provenance: { ...EMPTY_PROVENANCE, event_ids: ['evt_0001'] },
    ...overrides,
  };
}

function errorsOf(result: { ok: boolean; errors?: readonly string[] }): string {
  return (result.errors ?? []).join('\n');
}

describe('semantic claim provenance (SPEC-004 / DEC-004)', () => {
  it('a semantic claim whose provenance arrays are all empty fails validation', () => {
    const result = validateSemanticClaim(claim({ provenance: EMPTY_PROVENANCE }));
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain('/provenance');
    expect(validateAgainst('semanticClaim', claim({ provenance: EMPTY_PROVENANCE })).ok).toBe(false);
  });

  it.each(['event_ids', 'artifact_refs', 'workspace_paths', 'checkpoint_ids'])(
    'one non-empty %s array is enough evidence',
    (key) => {
      const evidence = key === 'checkpoint_ids' ? 'c_4' : key === 'workspace_paths' ? 'src/a.ts' : 'x_1';
      expect(validateSemanticClaim(claim({ provenance: { ...EMPTY_PROVENANCE, [key]: [evidence] } })).ok).toBe(true);
    },
  );

  it('empty-string evidence is not provenance', () => {
    expect(validateSemanticClaim(claim({ provenance: { ...EMPTY_PROVENANCE, event_ids: [''] } })).ok).toBe(false);
  });

  it('a provenance object missing one of the four arrays fails', () => {
    const { checkpoint_ids: _dropped, ...partial } = { ...EMPTY_PROVENANCE, event_ids: ['evt_0001'] };
    expect(validateSemanticClaim(claim({ provenance: partial })).ok).toBe(false);
    expect(validateSemanticClaim(claim({ provenance: undefined })).ok).toBe(false);
  });

  it('a claim can only speak about semantic fields, never a deterministic one', () => {
    for (const field of SEMANTIC_FIELDS) expect(validateSemanticClaim(claim({ field })).ok).toBe(true);
    for (const field of ['workspace_commit', 'ledger_seq', 'run_id', 'checkpoint_id', 'state_hash', 'usage', 'pending_intent']) {
      expect(validateSemanticClaim(claim({ field })).ok).toBe(false);
    }
  });

  it('origin must be agent_declared, distilled or human; confidence stays within [0, 1]', () => {
    for (const origin of CLAIM_ORIGINS) expect(validateSemanticClaim(claim({ origin })).ok).toBe(true);
    expect(validateSemanticClaim(claim({ origin: 'adapter' })).ok).toBe(false);
    expect(validateSemanticClaim(claim({ confidence: 0.7 })).ok).toBe(true);
    expect(validateSemanticClaim(claim({ confidence: 1.5 })).ok).toBe(false);
  });

  it('a projection carrying a claim with empty provenance fails validation', () => {
    const projection = {
      id: 'proj_1',
      checkpointId: 'c_3',
      distiller: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', promptVersion: 'distill-v1' },
      input: { stateHash: 'a'.repeat(64), ledgerRange: [10, 42], workspaceCommit: 'b'.repeat(40) },
      claims: [claim({ origin: 'distilled' })],
      usage: { inputTokens: 1200, outputTokens: 180, costUsd: 0.0021 },
      createdAt: '2026-09-13T12:00:00.000Z',
    };
    expect(validateSemanticProjection(projection).ok).toBe(true);
    const bad = { ...projection, claims: [claim({ origin: 'distilled' }), claim({ origin: 'distilled', provenance: EMPTY_PROVENANCE })] };
    const result = validateSemanticProjection(bad);
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain('/claims/1/provenance');
  });
});
