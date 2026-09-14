/**
 * DeclaredStateInput validation (SPEC-010 "Accepts" and "Limits"). Pure: no I/O, no imports beyond this module's
 * error type. It runs before the SDK talks to the Checkpoint Engine, so a rejected save() makes zero Engine calls.
 *
 * The returned value is a fresh copy holding only the set fields. Each input member is read exactly once, so a
 * caller that mutates its object (or has a getter) after validation cannot change what is forwarded.
 */
import { CkptValidationError } from './errors.js';

export interface DeclaredStateInput {
  goal?: string;
  current_step?: string;
  next_action?: string;
  decisions?: string[];
  assumptions?: string[];
}

export interface SaveOptions {
  label?: string;
}

/** A validated declaration: only the fields that were set, copied. */
export interface DeclaredState {
  readonly goal?: string;
  readonly current_step?: string;
  readonly next_action?: string;
  readonly decisions?: readonly string[];
  readonly assumptions?: readonly string[];
}

/** SPEC-010 "each string ≤ 64 KB", counted in UTF-8 bytes (64 × 1024, the unit of SPEC-002's env value limit). */
export const MAX_DECLARED_STRING_BYTES = 64 * 1024;

/** SPEC-010 "`decisions` and `assumptions` ≤ 1000 entries each". */
export const MAX_DECLARED_LIST_ENTRIES = 1000;

export const SCALAR_FIELDS = ['goal', 'current_step', 'next_action'] as const;
export const LIST_FIELDS = ['decisions', 'assumptions'] as const;

type ScalarField = (typeof SCALAR_FIELDS)[number];
type ListField = (typeof LIST_FIELDS)[number];

const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>([...SCALAR_FIELDS, ...LIST_FIELDS]);
const KNOWN_OPTIONS: ReadonlySet<string> = new Set<string>(['label']);

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkString(value: unknown, field: string, index?: number): string {
  if (typeof value !== 'string') {
    throw new CkptValidationError(field, `must be a string, got ${value === null ? 'null' : typeof value}`, index);
  }
  // A UTF-16 code unit encodes to at most 3 UTF-8 bytes, so short strings skip the byte count.
  if (value.length * 3 > MAX_DECLARED_STRING_BYTES) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_DECLARED_STRING_BYTES) {
      throw new CkptValidationError(field, `is ${bytes} UTF-8 bytes; the limit is ${MAX_DECLARED_STRING_BYTES} (64 KB)`, index);
    }
  }
  return value;
}

function checkList(value: unknown, field: ListField): string[] {
  if (!Array.isArray(value)) throw new CkptValidationError(field, 'must be an array of strings');
  if (value.length > MAX_DECLARED_LIST_ENTRIES) {
    throw new CkptValidationError(field, `has ${value.length} entries; the limit is ${MAX_DECLARED_LIST_ENTRIES}`);
  }
  const out: string[] = [];
  // Index loop, not map/forEach: a hole in a sparse array is read as undefined and rejected.
  for (let i = 0; i < value.length; i += 1) out.push(checkString((value as unknown[])[i], field, i));
  return out;
}

/**
 * Validates a `save()` declaration. Rejects with CkptValidationError naming the field for: a non-object, any
 * unknown key (never silently dropped), a wrong type, a string over 64 KB, a list over 1000 entries, or a
 * declaration that sets nothing. A field whose value is `undefined` counts as not set, and so does an empty
 * list, because it declares no claim.
 */
export function validateDeclaredState(state: unknown): DeclaredState {
  if (!isPlainObject(state)) {
    throw new CkptValidationError('state', 'must be a plain object {goal?, current_step?, next_action?, decisions?, assumptions?}');
  }
  for (const key of Reflect.ownKeys(state)) {
    if (typeof key !== 'string' || !KNOWN_FIELDS.has(key)) {
      throw new CkptValidationError(String(key), 'is not a DeclaredStateInput field (goal, current_step, next_action, decisions, assumptions)');
    }
  }

  const out: { -readonly [K in keyof DeclaredState]: DeclaredState[K] } = {};
  let claims = 0;
  for (const field of SCALAR_FIELDS) {
    const value = state[field];
    if (value === undefined) continue;
    out[field as ScalarField] = checkString(value, field);
    claims += 1;
  }
  for (const field of LIST_FIELDS) {
    const value = state[field];
    if (value === undefined) continue;
    const list = checkList(value, field);
    if (list.length === 0) continue;
    out[field] = list;
    claims += list.length;
  }
  if (claims === 0) {
    throw new CkptValidationError('state', 'declares nothing: set at least one of goal, current_step, next_action, decisions, assumptions');
  }
  return out;
}

/** Validates `save()`'s `{label?}`. Returns the label, or null when none was given. */
export function validateSaveOptions(options: unknown): string | null {
  if (options === undefined) return null;
  if (!isPlainObject(options)) throw new CkptValidationError('options', 'must be a plain object {label?}');
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !KNOWN_OPTIONS.has(key)) {
      throw new CkptValidationError(String(key), 'is not a save() option (label)');
    }
  }
  const label = options['label'];
  if (label === undefined) return null;
  const checked = checkString(label, 'label');
  if (checked === '') throw new CkptValidationError('label', 'must be a non-empty string');
  return checked;
}
