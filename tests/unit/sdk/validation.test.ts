/**
 * SPEC-010 "Limits": at least one field, no unknown keys, each string ≤ 64 KB, lists ≤ 1000 entries. A rejection is a
 * CkptValidationError naming the offending field.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Checkpoint, LedgerEvent, LedgerEventDraft } from '../../../src/model/types.js';
import { CkptValidationError, isCkptValidationError } from '../../../src/sdk/errors.js';
import { createCkpt, type DeclaredStateEngine, type DeclaredStateInput } from '../../../src/sdk/index.js';
import {
  MAX_DECLARED_LIST_ENTRIES,
  MAX_DECLARED_STRING_BYTES,
  validateDeclaredState,
  validateSaveOptions,
} from '../../../src/sdk/validate.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';

describe('save() rejects invalid input before the Engine is called', () => {
  function spiedEngine(): { engine: DeclaredStateEngine; record: ReturnType<typeof vi.fn>; checkpoint: ReturnType<typeof vi.fn> } {
    const record = vi.fn(async (_drafts: readonly LedgerEventDraft[]): Promise<LedgerEvent[]> => []);
    const checkpoint = vi.fn(async (_runId: string): Promise<Checkpoint> => ({}) as Checkpoint);
    return { engine: { record, checkpoint }, record, checkpoint };
  }

  it.each([
    ['an empty object', {}, 'state'],
    ['an unknown key', { goal: 'g', mood: 'fine' }, 'mood'],
    ['a string > 64 KB', { next_action: 'x'.repeat(MAX_DECLARED_STRING_BYTES + 1) }, 'next_action'],
    ['a list entry > 64 KB', { decisions: ['ok', 'y'.repeat(MAX_DECLARED_STRING_BYTES + 1)] }, 'decisions'],
  ])('%s rejects with CkptValidationError and the Engine record() spy is called 0 times', async (_name, input, field) => {
    const { engine, record, checkpoint } = spiedEngine();
    const ckpt = createCkpt({ engine, runId: 'run_01J00000000000000000000000' });
    const outcome = ckpt.save(input as DeclaredStateInput);
    await expect(outcome).rejects.toBeInstanceOf(CkptValidationError);
    await expect(outcome).rejects.toMatchObject({ field });
    expect(record).toHaveBeenCalledTimes(0);
    expect(checkpoint).toHaveBeenCalledTimes(0);
  });

  it('an invalid label also rejects before the Engine is called', async () => {
    const { engine, record, checkpoint } = spiedEngine();
    const ckpt = createCkpt({ engine, runId: 'run_01J00000000000000000000000' });
    await expect(ckpt.save({ goal: 'g' }, { label: '' })).rejects.toMatchObject({ name: 'CkptValidationError', field: 'label' });
    expect(record).toHaveBeenCalledTimes(0);
    expect(checkpoint).toHaveBeenCalledTimes(0);
  });
});

function rejection(fn: () => unknown): CkptValidationError {
  try {
    fn();
  } catch (err) {
    expect(isCkptValidationError(err)).toBe(true);
    return err as CkptValidationError;
  }
  throw new Error('expected a CkptValidationError, but nothing was thrown');
}

describe('validateDeclaredState', () => {
  it('limits are SPEC-010 figures: 64 KB (UTF-8 bytes) and 1000 entries', () => {
    expect(MAX_DECLARED_STRING_BYTES).toBe(65_536);
    expect(MAX_DECLARED_LIST_ENTRIES).toBe(1000);
  });

  it('rejects an empty object, naming the state', () => {
    const err = rejection(() => validateDeclaredState({}));
    expect(err).toBeInstanceOf(CkptValidationError);
    expect(err.name).toBe('CkptValidationError');
    expect(err.field).toBe('state');
  });

  it.each([
    ['only undefined fields', { goal: undefined, decisions: undefined }],
    ['only empty lists', { decisions: [], assumptions: [] }],
  ])('rejects a declaration with %s as setting nothing', (_name, input) => {
    expect(rejection(() => validateDeclaredState(input)).field).toBe('state');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', ['goal']],
    ['a string', 'goal'],
    ['a class instance', new (class Declared { goal = 'g'; })()],
    ['an object with a custom prototype', Object.create({ goal: 'inherited' }) as object],
  ])('rejects %s as the state', (_name, input) => {
    expect(rejection(() => validateDeclaredState(input)).field).toBe('state');
  });

  it('rejects an unknown key alongside valid ones, naming it (never silently dropped)', () => {
    const err = rejection(() => validateDeclaredState({ goal: 'g', mood: 'fine' }));
    expect(err.field).toBe('mood');
  });

  it.each([['plan'], ['decision'], ['Goal'], ['constraints'], ['__proto__x']])('rejects the unknown key %s', (key) => {
    expect(rejection(() => validateDeclaredState({ next_action: 'n', [key]: 'x' })).field).toBe(key);
  });

  it('rejects a symbol key', () => {
    const key = Symbol('goal');
    expect(rejection(() => validateDeclaredState({ goal: 'g', [key]: 'x' })).field).toBe('Symbol(goal)');
  });

  it.each([['goal'], ['current_step'], ['next_action']] as const)('rejects %s over 64 KB', (field) => {
    const err = rejection(() => validateDeclaredState({ [field]: 'a'.repeat(MAX_DECLARED_STRING_BYTES + 1) }));
    expect(err.field).toBe(field);
    expect(err.index).toBeUndefined();
  });

  it('accepts a string of exactly 64 KB', () => {
    const goal = 'a'.repeat(MAX_DECLARED_STRING_BYTES);
    expect(validateDeclaredState({ goal })).toEqual({ goal });
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // 32,769 two-byte characters: 65,538 bytes, fewer than 64 KB code units.
    expect(rejection(() => validateDeclaredState({ goal: 'é'.repeat(32_769) })).field).toBe('goal');
    // 16,384 four-byte emoji: exactly 65,536 bytes.
    expect(() => validateDeclaredState({ goal: '😀'.repeat(16_384) })).not.toThrow();
  });

  it.each([['decisions'], ['assumptions']] as const)('rejects an entry of %s over 64 KB, naming the field and index', (field) => {
    const err = rejection(() => validateDeclaredState({ [field]: ['ok', 'ok', 'b'.repeat(MAX_DECLARED_STRING_BYTES + 1)] }));
    expect(err.field).toBe(field);
    expect(err.index).toBe(2);
  });

  it.each([['decisions'], ['assumptions']] as const)('rejects %s with more than 1000 entries and accepts exactly 1000', (field) => {
    expect(rejection(() => validateDeclaredState({ [field]: Array.from({ length: 1001 }, (_, i) => `e${i}`) })).field).toBe(field);
    expect(validateDeclaredState({ [field]: Array.from({ length: 1000 }, (_, i) => `e${i}`) })[field]).toHaveLength(1000);
  });

  it.each([
    ['goal', { goal: 5 }],
    ['current_step', { current_step: null }],
    ['next_action', { next_action: ['n'] }],
    ['decisions', { decisions: 'd' }],
    ['assumptions', { assumptions: { 0: 'a' } }],
  ])('rejects a wrongly typed %s', (field, input) => {
    expect(rejection(() => validateDeclaredState(input)).field).toBe(field);
  });

  it('rejects a non-string list entry and a hole in a sparse list', () => {
    expect(rejection(() => validateDeclaredState({ decisions: ['d', 1] })).index).toBe(1);
    // eslint-disable-next-line no-sparse-arrays
    expect(rejection(() => validateDeclaredState({ assumptions: ['a', , 'c'] })).index).toBe(1);
  });

  it('never echoes a declared value in the error', () => {
    for (const { value } of secretCorpus()) {
      const err = rejection(() => validateDeclaredState({ goal: value + 'x'.repeat(MAX_DECLARED_STRING_BYTES) }));
      expect(err.message).not.toContain(value);
    }
  });

  it('returns a copy holding only the set fields', () => {
    const decisions = ['d1'];
    const input = { goal: 'g', current_step: undefined, decisions, assumptions: [] as string[] };
    const out = validateDeclaredState(input);
    expect(out).toEqual({ goal: 'g', decisions: ['d1'] });
    expect(Object.keys(out)).toEqual(['goal', 'decisions']);
    decisions.push('d2');
    input.goal = 'changed';
    expect(out).toEqual({ goal: 'g', decisions: ['d1'] });
  });

  it('reads each member once, so a getter cannot pass validation with one value and forward another', () => {
    let reads = 0;
    const input = {
      get goal(): string {
        reads += 1;
        return reads === 1 ? 'short' : 'x'.repeat(MAX_DECLARED_STRING_BYTES + 1);
      },
    };
    expect(validateDeclaredState(input)).toEqual({ goal: 'short' });
    expect(reads).toBe(1);
  });
});

describe('validateSaveOptions', () => {
  it('accepts no options or no label as null, and returns a given label', () => {
    expect(validateSaveOptions(undefined)).toBeNull();
    expect(validateSaveOptions({})).toBeNull();
    expect(validateSaveOptions({ label: undefined })).toBeNull();
    expect(validateSaveOptions({ label: 'milestone' })).toBe('milestone');
  });

  it.each([
    ['label', { label: '' }],
    ['label', { label: 7 }],
    ['label', { label: 'l'.repeat(MAX_DECLARED_STRING_BYTES + 1) }],
    ['labels', { labels: 'x' }],
    ['options', null],
    ['options', 'label'],
  ])('rejects bad options, naming %s', (field, options) => {
    expect(rejection(() => validateSaveOptions(options)).field).toBe(field);
  });
});
