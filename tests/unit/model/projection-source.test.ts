/**
 * SPEC-015 amendment 3 / SPEC-004 v3: SemanticProjection.source is required ('distilled' | 'declared'). distiller and
 * usage are nullable, but a 'distilled' projection must carry a distiller block (and its usage).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_FILES, schemaDir } from '../../../src/model/schemas.js';
import { PROJECTION_SOURCES, type SemanticProjection } from '../../../src/model/types.js';
import { validateSemanticProjection } from '../../../src/model/validate.js';

const DISTILLER = { provider: 'anthropic', model: 'claude-haiku-4-5', promptVersion: 'distill-v1' } as const;
const USAGE = { inputTokens: 900, outputTokens: 80, costUsd: 0.0013 } as const;
const PROVENANCE = { event_ids: ['evt_9'], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] };

function declared(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'proj_declared_1',
    checkpointId: 'c_3',
    source: 'declared',
    distiller: null,
    input: { stateHash: 'a'.repeat(64), ledgerRange: [4, 9], workspaceCommit: 'b'.repeat(40) },
    claims: [
      { field: 'goal', value: 'Land the S14 amendment', origin: 'agent_declared', provenance: PROVENANCE },
      { field: 'next_action', value: 'Run the storage tests', origin: 'agent_declared', provenance: PROVENANCE },
    ],
    usage: null,
    createdAt: '2026-09-14T03:00:00.000Z',
    ...overrides,
  };
}

function errorsOf(result: ReturnType<typeof validateSemanticProjection>): string {
  return result.ok ? '' : result.errors.join('\n');
}

describe('SemanticProjection.source (SPEC-015 amendment 3)', () => {
  it('source is required and is exactly distilled or declared', () => {
    const schema = JSON.parse(readFileSync(join(schemaDir(), SCHEMA_FILES.semanticProjection), 'utf8')) as {
      required: string[];
      properties: { source: { enum: string[] } };
    };
    expect(schema.required).toContain('source');
    expect(schema.properties.source.enum).toEqual(['distilled', 'declared']);
    expect([...PROJECTION_SOURCES]).toEqual(['distilled', 'declared']);

    const { source: _dropped, ...missing } = declared();
    const result = validateSemanticProjection(missing);
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain('source');
    for (const source of ['human', 'distiled', '', null]) {
      expect(validateSemanticProjection(declared({ source })).ok).toBe(false);
    }
  });

  it("a projection with source 'declared' and null distiller and usage validates", () => {
    const projection = declared();
    expect(validateSemanticProjection(projection)).toEqual({ ok: true, value: projection });

    // The TypeScript model admits the same shape without a faked distiller block.
    const typed: SemanticProjection = {
      id: 'proj_declared_2',
      checkpointId: 'c_1',
      source: 'declared',
      distiller: null,
      input: { stateHash: 'c'.repeat(64), ledgerRange: [0, 3], workspaceCommit: 'd'.repeat(40) },
      claims: [{ field: 'current_step', value: 'writing tests', origin: 'agent_declared', provenance: PROVENANCE }],
      usage: null,
      createdAt: '2026-09-14T03:01:00.000Z',
    };
    expect(validateSemanticProjection(typed).ok).toBe(true);
  });

  it("a 'declared' projection may still record a distiller and usage", () => {
    expect(validateSemanticProjection(declared({ distiller: DISTILLER, usage: USAGE })).ok).toBe(true);
  });

  it("a projection with source 'distilled' and a null distiller fails", () => {
    const result = validateSemanticProjection(declared({ source: 'distilled', usage: USAGE }));
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain('/distiller');
  });

  it("a projection with source 'distilled' and a null usage fails", () => {
    const result = validateSemanticProjection(declared({ source: 'distilled', distiller: DISTILLER }));
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toContain('/usage');
  });

  it("a projection with source 'distilled', a distiller and usage validates", () => {
    expect(validateSemanticProjection(declared({ source: 'distilled', distiller: DISTILLER, usage: USAGE })).ok).toBe(true);
  });

  it('a distiller or usage block, when present, keeps its required members', () => {
    expect(validateSemanticProjection(declared({ source: 'distilled', distiller: { ...DISTILLER, model: '' }, usage: USAGE })).ok).toBe(false);
    expect(validateSemanticProjection(declared({ distiller: { provider: 'anthropic' } })).ok).toBe(false);
    expect(validateSemanticProjection(declared({ usage: { ...USAGE, inputTokens: -1 } })).ok).toBe(false);
    expect(validateSemanticProjection(declared({ distiller: 'anthropic' })).ok).toBe(false);
  });
});
