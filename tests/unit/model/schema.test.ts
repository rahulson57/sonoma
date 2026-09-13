import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEDGER_ACTORS, LEDGER_EVENT_TYPES } from '../../../src/ledger/event-types.js';
import { chainHash } from '../../../src/ledger/hash.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import { SCHEMA_BASE_URI, SCHEMA_FILES, schemaDir, validateAgainst } from '../../../src/model/schemas.js';
import { CLAIM_ORIGINS, INTENT_STATUSES, REVERSIBILITY, SEMANTIC_FIELDS, type LedgerEvent } from '../../../src/model/types.js';
import {
  validateAgentState,
  validateCheckpoint,
  validateEvent,
  validateSemanticClaim,
  validateSemanticProjection,
  validateSideEffect,
} from '../../../src/model/validate.js';

// Fixture location: SPEC-004's criterion names tests/fixtures/model, which is outside TASK-003's
// file scope (raised as Q-006). Until that is settled the fixtures live beside this test.
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Json;
}

function schemaFile(file: string): Json {
  return JSON.parse(readFileSync(join(schemaDir(), file), 'utf8')) as Json;
}

function without(object: Json, key: string): Json {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function messages(result: { ok: true } | { ok: false; issues: ReadonlyArray<{ path: string; message: string }> }): string {
  return result.ok ? '' : result.issues.map((i) => `${i.path} ${i.message}`).join('\n');
}

describe('schema/ files', () => {
  it('schema/ holds exactly the registered files, each draft 2020-12 with its canonical $id', () => {
    const onDisk = readdirSync(schemaDir()).filter((f) => f.endsWith('.json')).sort();
    expect(onDisk).toEqual(Object.values(SCHEMA_FILES).sort());
    for (const file of onDisk) {
      const schema = schemaFile(file);
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema['$id']).toBe(SCHEMA_BASE_URI + file);
    }
  });

  it('enums in the schema files equal the TypeScript model constants', () => {
    type Props = { properties: Record<string, { enum: string[] }> };
    const event = schemaFile(SCHEMA_FILES.ledgerEvent) as unknown as Props;
    expect(event.properties['type']?.enum).toEqual([...LEDGER_EVENT_TYPES]);
    expect(event.properties['actor']?.enum).toEqual([...LEDGER_ACTORS]);
    const claim = schemaFile(SCHEMA_FILES.semanticClaim) as unknown as Props;
    expect(claim.properties['field']?.enum).toEqual([...SEMANTIC_FIELDS]);
    expect(claim.properties['origin']?.enum).toEqual([...CLAIM_ORIGINS]);
    const sideEffect = schemaFile(SCHEMA_FILES.sideEffect) as unknown as Props;
    expect(sideEffect.properties['reversibility']?.enum).toEqual([...REVERSIBILITY]);
    const state = schemaFile(SCHEMA_FILES.agentState) as unknown as { $defs: { PendingIntent: Props } };
    expect(state.$defs.PendingIntent.properties['status']?.enum).toEqual([...INTENT_STATUSES]);
  });
});

describe('checkpoint.schema.json', () => {
  const checkpoint = fixture('checkpoint.json');

  it('validates the checkpoint fixture', () => {
    expect(messages(validateAgainst('checkpoint', checkpoint))).toBe('');
    expect(validateCheckpoint(checkpoint)).toEqual({ ok: true, value: checkpoint });
  });

  it('rejects a checkpoint with schemaVersion missing', () => {
    const missing = without(checkpoint, 'schemaVersion');
    expect(messages(validateAgainst('checkpoint', missing))).toContain('missing required property "schemaVersion"');
    const result = validateCheckpoint(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('schemaVersion');
  });

  it('rejects a schemaVersion it does not know', () => {
    for (const version of [2, 0, '1', null]) {
      const result = validateCheckpoint({ ...checkpoint, schemaVersion: version });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join('\n')).toContain('schemaVersion');
      expect(validateAgainst('checkpoint', { ...checkpoint, schemaVersion: version }).ok).toBe(false);
    }
  });

  it('rejects a state_hash that is not the state blob hash, and unknown members', () => {
    expect(validateCheckpoint({ ...checkpoint, state_hash: 'e'.repeat(64) }).ok).toBe(false);
    expect(validateCheckpoint({ ...checkpoint, goal: 'semantic fields do not belong on a checkpoint' }).ok).toBe(false);
  });
});

describe('ledger-event.schema.json', () => {
  const inline = fixture('ledger-event.inline.json');
  const blob = fixture('ledger-event.blob.json');

  it('validates the inline-payload and blob-payload fixtures', () => {
    expect(messages(validateAgainst('ledgerEvent', inline))).toBe('');
    expect(messages(validateAgainst('ledgerEvent', blob))).toBe('');
    expect(validateEvent(inline).ok).toBe(true);
    expect(validateEvent(blob).ok).toBe(true);
  });

  it('fixture hashes are real chain hashes', () => {
    expect(chainHash(inline['prev_hash'] as string, inline)).toBe(inline['hash']);
    expect(verifyChain([inline, blob] as unknown as LedgerEvent[])).toEqual({ ok: true });
  });

  it('rejects an unknown event type', () => {
    for (const type of ['state.declared', 'agent.suspended', 'tool.done', '']) {
      const result = validateAgainst('ledgerEvent', { ...inline, type });
      expect(result.ok).toBe(false);
      expect(messages(result)).toContain('/type');
    }
  });

  it('rejects an unknown actor', () => {
    expect(validateAgainst('ledgerEvent', { ...inline, actor: 'adapter' }).ok).toBe(false);
  });

  it('requires exactly one of payload and payload_ref', () => {
    expect(validateAgainst('ledgerEvent', { ...inline, payload_ref: blob['payload_ref'] }).ok).toBe(false);
    expect(validateAgainst('ledgerEvent', { ...inline, payload: null }).ok).toBe(false);
    expect(validateAgainst('ledgerEvent', without(inline, 'payload_ref')).ok).toBe(false);
  });

  it('rejects members the ledger does not define', () => {
    expect(validateAgainst('ledgerEvent', { ...inline, schema_hint: 'x' }).ok).toBe(false);
  });
});

describe('semantic-claim.schema.json and semantic-projection.schema.json', () => {
  it('validates the claim fixture', () => {
    const claim = fixture('semantic-claim.json');
    expect(messages(validateAgainst('semanticClaim', claim))).toBe('');
    expect(validateSemanticClaim(claim).ok).toBe(true);
  });

  it('validates the projection fixture', () => {
    const projection = fixture('semantic-projection.json');
    expect(messages(validateAgainst('semanticProjection', projection))).toBe('');
    expect(validateSemanticProjection(projection).ok).toBe(true);
  });

  it('rejects a projection whose ledger range runs backwards', () => {
    const projection = fixture('semantic-projection.json');
    const input = projection['input'] as Json;
    expect(validateSemanticProjection({ ...projection, input: { ...input, ledgerRange: [9, 3] } }).ok).toBe(false);
  });
});

describe('agent-state.schema.json and side-effect.schema.json', () => {
  it('validates the agent state fixture and rejects a missing or unknown schemaVersion', () => {
    const state = fixture('agent-state.json');
    expect(messages(validateAgainst('agentState', state))).toBe('');
    expect(validateAgentState(state).ok).toBe(true);
    expect(validateAgentState(without(state, 'schemaVersion')).ok).toBe(false);
    expect(validateAgentState({ ...state, schemaVersion: 2 }).ok).toBe(false);
  });

  it('the checkpoint fixture points at the agent state fixture by hash', async () => {
    const { canonicalJSON } = await import('../../../src/ledger/canonical-json.js');
    const { sha256Hex } = await import('../../../src/ledger/hash.js');
    const bytes = Buffer.from(canonicalJSON(fixture('agent-state.json')), 'utf8');
    expect(fixture('checkpoint.json')['state_blob']).toEqual({ sha256: sha256Hex(bytes), size: bytes.byteLength });
  });

  it('validates the side-effect fixture', () => {
    const sideEffect = fixture('side-effect.json');
    expect(messages(validateAgainst('sideEffect', sideEffect))).toBe('');
    expect(validateSideEffect(sideEffect)).toEqual({ ok: true, value: sideEffect });
  });
});
