import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { GENESIS_PREV_HASH, chainHash, sha256Hex } from '../../../src/ledger/hash.js';

describe('canonicalJSON', () => {
  it('sorts object keys at every depth and emits no whitespace', () => {
    expect(canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('is independent of key insertion order', () => {
    const a = { run_id: 'r', seq: 1, payload: { x: 1, y: [true, null] } };
    const b = { payload: { y: [true, null], x: 1 }, seq: 1, run_id: 'r' };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it('sorts keys by UTF-16 code units', () => {
    expect(canonicalJSON({ é: 1, z: 2, A: 3, _: 4 })).toBe('{"A":3,"_":4,"z":2,"é":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serialises strings and numbers exactly as JSON.stringify', () => {
    const s = 'quote " backslash \\ newline \n tab \t unicode ✓ ';
    expect(canonicalJSON(s)).toBe(JSON.stringify(s));
    for (const n of [0, -0, 1, -1.5, 1e21, 1e-7, 123456789.125, Number.MAX_SAFE_INTEGER]) {
      expect(canonicalJSON(n)).toBe(JSON.stringify(n));
    }
  });

  it('is stable across a JSON round-trip (what storage does to an event)', () => {
    const value = { b: [1, { c: 'x', a: null }], a: false, n: -0, u: undefined };
    const roundTripped: unknown = JSON.parse(JSON.stringify(value));
    expect(canonicalJSON(roundTripped)).toBe(canonicalJSON(value));
  });

  it('omits undefined object members, like JSON.stringify', () => {
    expect(canonicalJSON({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o['k'] = 'v';
    expect(canonicalJSON(o)).toBe('{"k":"v"}');
  });

  it('rejects values that would not survive a JSON round-trip', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const bad: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      () => 1,
      Symbol('s'),
      undefined,
      [1, undefined],
      new Date(0),
      new Map(),
      new Uint8Array(2),
      { nested: { when: new Date(0) } },
      cyclic,
    ];
    for (const value of bad) {
      expect(() => canonicalJSON(value)).toThrow(CanonicalJsonError);
    }
  });

  it('allows the same object to appear twice when it is not a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalJSON({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('chainHash', () => {
  it('is sha256(prev_hash ‖ canonicalJSON(event without hash))', () => {
    const event = { seq: 1, run_id: 'run_x', prev_hash: GENESIS_PREV_HASH, payload: { b: 2, a: 1 } };
    const expected = sha256Hex(GENESIS_PREV_HASH + canonicalJSON(event));
    expect(chainHash(GENESIS_PREV_HASH, event)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores a hash member already present on the event', () => {
    const body = { seq: 2, prev_hash: 'a'.repeat(64) };
    expect(chainHash('a'.repeat(64), { ...body, hash: 'f'.repeat(64) })).toBe(chainHash('a'.repeat(64), body));
  });

  it('changes when prev_hash or any body byte changes', () => {
    const body = { seq: 1, payload: { text: 'hello' } };
    const base = chainHash(GENESIS_PREV_HASH, body);
    expect(chainHash('1'.repeat(64), body)).not.toBe(base);
    expect(chainHash(GENESIS_PREV_HASH, { seq: 1, payload: { text: 'hellp' } })).not.toBe(base);
  });

  it('genesis prev_hash is 64 zero hex digits', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
  });
});
