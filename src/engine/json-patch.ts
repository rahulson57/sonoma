/**
 * State diff as an RFC 6902 JSON Patch (SPEC-006 `diff(a, b).state`).
 *
 * Objects are compared member by member (keys in sorted order, so the patch is deterministic); arrays and
 * scalars are replaced whole when they differ. Applying the patch to `a` yields `b`.
 */
import { canonicalJSON } from '../ledger/canonical-json.js';
import type { JsonPatch } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function token(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

export function diffJson(a: unknown, b: unknown, pointer = ''): JsonPatch {
  if (isObject(a) && isObject(b)) {
    const patch: JsonPatch = [];
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const at = `${pointer}/${token(key)}`;
      const inA = Object.hasOwn(a, key);
      const inB = Object.hasOwn(b, key);
      if (inA && !inB) patch.push({ op: 'remove', path: at });
      else if (!inA && inB) patch.push({ op: 'add', path: at, value: b[key] });
      else patch.push(...diffJson(a[key], b[key], at));
    }
    return patch;
  }
  return same(a, b) ? [] : [{ op: 'replace', path: pointer, value: b }];
}
