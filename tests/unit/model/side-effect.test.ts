import { describe, expect, it } from 'vitest';
import { DEFAULT_REVERSIBILITY, REVERSIBILITY, type SideEffectInput } from '../../../src/model/types.js';
import { ModelValidationError, createSideEffect, validateSideEffect } from '../../../src/model/validate.js';

const BASE: SideEffectInput = {
  type: 'http.request',
  target: 'POST https://api.example.com/v1/deploy',
  request_hash: 'a'.repeat(64),
  response_hash: 'b'.repeat(64),
};

describe('SideEffect reversibility (SPEC-004)', () => {
  it('a SideEffect without explicit reversibility defaults to irreversible', () => {
    expect(DEFAULT_REVERSIBILITY).toBe('irreversible');
    expect(createSideEffect(BASE).reversibility).toBe('irreversible');
    expect(createSideEffect({ ...BASE, reversibility: undefined }).reversibility).toBe('irreversible');
  });

  it('applies the same default when validating a stored side effect', () => {
    const result = validateSideEffect({ ...BASE });
    expect(result).toEqual({ ok: true, value: { ...BASE, reversibility: 'irreversible' } });
  });

  it.each([...REVERSIBILITY])('keeps an explicit %s', (reversibility) => {
    expect(createSideEffect({ ...BASE, reversibility }).reversibility).toBe(reversibility);
  });

  it('rejects an unknown reversibility instead of defaulting it', () => {
    expect(() => createSideEffect({ ...BASE, reversibility: 'undoable' as never })).toThrow(ModelValidationError);
    expect(validateSideEffect({ ...BASE, reversibility: null }).ok).toBe(false);
  });

  it('does not mutate its input', () => {
    const input = { ...BASE };
    createSideEffect(input);
    expect(input).toEqual(BASE);
    expect('reversibility' in input).toBe(false);
  });

  it('rejects a side effect missing a required field or carrying a malformed hash', () => {
    const { target: _target, ...noTarget } = BASE;
    expect(() => createSideEffect(noTarget as SideEffectInput)).toThrow(ModelValidationError);
    expect(validateSideEffect({ ...BASE, request_hash: 'not-a-hash' }).ok).toBe(false);
  });
});
