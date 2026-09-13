import { describe, expect, it } from 'vitest';
import {
  DRAFT_2020_12,
  SchemaDefinitionError,
  SchemaRegistry,
  type SchemaIssue,
  type SchemaValidation,
} from '../../../src/model/json-schema.js';

const BASE = 'https://ckpt.local/test/';

function registryWith(...schemas: Array<Record<string, unknown>>): SchemaRegistry {
  const registry = new SchemaRegistry();
  for (const schema of schemas) registry.add({ $schema: DRAFT_2020_12, ...schema });
  return registry;
}

function check(schema: Record<string, unknown>, value: unknown): SchemaValidation {
  return registryWith({ $id: `${BASE}s.json`, ...schema }).validate(`${BASE}s.json`, value);
}

const ok = (schema: Record<string, unknown>, value: unknown): boolean => check(schema, value).ok;
const issuesOf = (result: SchemaValidation): readonly SchemaIssue[] => (result.ok ? [] : result.issues);

describe('SchemaRegistry — the JSON Schema subset behind schema/*.json', () => {
  it('type distinguishes integer, number, string, boolean, null, array and plain object', () => {
    expect(ok({ type: 'integer' }, 3)).toBe(true);
    expect(ok({ type: 'integer' }, 3.5)).toBe(false);
    expect(ok({ type: 'number' }, 3.5)).toBe(true);
    expect(ok({ type: 'number' }, Number.NaN)).toBe(false);
    expect(ok({ type: 'string' }, 's')).toBe(true);
    expect(ok({ type: 'boolean' }, 0)).toBe(false);
    expect(ok({ type: 'null' }, null)).toBe(true);
    expect(ok({ type: 'array' }, [])).toBe(true);
    expect(ok({ type: 'object' }, {})).toBe(true);
    for (const notObject of [[], null, new Date(0), new Map()]) expect(ok({ type: 'object' }, notObject)).toBe(false);
    expect(ok({ type: ['string', 'null'] }, null)).toBe(true);
    expect(ok({ type: ['string', 'null'] }, 1)).toBe(false);
  });

  it('required, properties and additionalProperties: false report JSON-pointer paths', () => {
    const schema = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
    };
    expect(ok(schema, { a: 'x' })).toBe(true);
    expect(issuesOf(check(schema, {}))).toEqual([{ path: '', message: 'missing required property "a"' }]);
    expect(issuesOf(check(schema, { a: 'x', c: 1 }))).toEqual([{ path: '/c', message: 'unknown property "c"' }]);
    expect(issuesOf(check(schema, { a: 'x', b: 'no' }))[0]?.path).toBe('/b');
  });

  it('treats an undefined member as absent, as JSON does', () => {
    const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } };
    expect(ok(schema, { a: undefined })).toBe(false);
    expect(ok(schema, { a: 'x', b: undefined })).toBe(true);
  });

  it('enum and const compare JSON values deeply', () => {
    expect(ok({ enum: [{ k: [1] }, 'x'] }, { k: [1] })).toBe(true);
    expect(ok({ enum: [{ k: [1] }, 'x'] }, { k: [2] })).toBe(false);
    expect(ok({ const: 1 }, 1)).toBe(true);
    expect(ok({ const: 1 }, '1')).toBe(false);
  });

  it('pattern is honoured and minLength counts code points', () => {
    const id = { type: 'string', pattern: '^c_[1-9][0-9]*$' };
    expect(ok(id, 'c_12')).toBe(true);
    expect(ok(id, 'c_0')).toBe(false);
    expect(ok(id, ' c_1')).toBe(false);
    expect(ok({ type: 'string', minLength: 2 }, '✓✓')).toBe(true);
    expect(ok({ type: 'string', minLength: 2 }, '😀')).toBe(false);
  });

  it('minimum, maximum, minItems, maxItems and items', () => {
    expect(ok({ type: 'number', minimum: 0, maximum: 1 }, 1)).toBe(true);
    expect(ok({ type: 'number', minimum: 0, maximum: 1 }, 1.01)).toBe(false);
    expect(ok({ type: 'number', minimum: 0, maximum: 1 }, -0.01)).toBe(false);
    const pair = { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 };
    expect(ok(pair, [1, 2])).toBe(true);
    expect(ok(pair, [1])).toBe(false);
    expect(ok(pair, [1, 2, 3])).toBe(false);
    expect(issuesOf(check(pair, [1, 'two']))[0]?.path).toBe('/1');
  });

  it('anyOf passes when any branch matches and reports every branch otherwise', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 10 }] };
    expect(ok(schema, 's')).toBe(true);
    expect(ok(schema, 12)).toBe(true);
    const issues = issuesOf(check(schema, 3));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/\[1\].*\[2\]/);
  });

  it('resolves $ref within a document and across registered documents', () => {
    const registry = registryWith(
      { $id: `${BASE}common.json`, $defs: { Id: { type: 'string', pattern: '^id_' } } },
      {
        $id: `${BASE}thing.json`,
        type: 'object',
        required: ['id', 'child'],
        properties: { id: { $ref: 'common.json#/$defs/Id' }, child: { $ref: '#/$defs/Child' } },
        $defs: { Child: { type: 'integer' } },
      },
    );
    expect(registry.validate(`${BASE}thing.json`, { id: 'id_1', child: 2 }).ok).toBe(true);
    expect(registry.validate(`${BASE}thing.json`, { id: 'x', child: 2 }).ok).toBe(false);
    expect(registry.validate(`${BASE}thing.json`, { id: 'id_1', child: 'two' }).ok).toBe(false);
  });

  it('refuses a schema that uses a keyword it does not implement, at any depth', () => {
    const unsupported = [
      { format: 'date-time' },
      { properties: { a: { oneOf: [{ type: 'string' }] } } },
      { items: { if: { type: 'string' } } },
      { $defs: { X: { multipleOf: 2 } } },
      { anyOf: [{ patternProperties: {} }] },
    ];
    for (const extra of unsupported) {
      expect(() => registryWith({ $id: `${BASE}bad.json`, ...extra })).toThrow(SchemaDefinitionError);
    }
  });

  it('refuses a root without the draft 2020-12 $schema, an absolute $id, or with a duplicate $id', () => {
    expect(() => new SchemaRegistry().add({ $id: `${BASE}a.json` })).toThrow(SchemaDefinitionError);
    expect(() =>
      new SchemaRegistry().add({ $schema: 'http://json-schema.org/draft-07/schema#', $id: `${BASE}a.json` }),
    ).toThrow(SchemaDefinitionError);
    expect(() => new SchemaRegistry().add({ $schema: DRAFT_2020_12, $id: 'relative.json' })).toThrow(SchemaDefinitionError);
    expect(() => registryWith({ $id: `${BASE}a.json` }, { $id: `${BASE}a.json` })).toThrow(SchemaDefinitionError);
  });

  it('refuses an invalid pattern at registration and an unresolvable $ref at validation', () => {
    expect(() => registryWith({ $id: `${BASE}p.json`, type: 'string', pattern: '(' })).toThrow(SchemaDefinitionError);
    const registry = registryWith({ $id: `${BASE}r.json`, $ref: 'missing.json' });
    expect(() => registry.validate(`${BASE}r.json`, 1)).toThrow(SchemaDefinitionError);
  });
});
