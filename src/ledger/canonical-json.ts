/**
 * Canonical JSON — the byte form the ledger hash chain is computed over (SPEC-004:
 * `hash = sha256(prev_hash ‖ canonicalJSON(event without hash))`).
 *
 * RFC 8785 (JCS)-style:
 * - object members sorted by key, comparing UTF-16 code units (the default `Array#sort` order);
 * - no insignificant whitespace;
 * - strings and finite numbers serialised exactly as `JSON.stringify` does (ECMAScript number
 *   serialisation is what JCS specifies; `-0` becomes `0`).
 *
 * The output is identical for any two values that are equal after a JSON round-trip, so a hash
 * computed at append time still verifies after the event has been stored as JSON and read back.
 * For the same reason, anything that would NOT survive that round-trip unchanged is rejected
 * rather than silently coerced: non-finite numbers, bigint, functions, symbols, `undefined` array
 * elements, non-plain objects (Date, Map, class instances, typed arrays) and cycles. An `undefined`
 * object member is omitted, exactly as `JSON.stringify` drops it.
 */

export class CanonicalJsonError extends TypeError {
  override readonly name = 'CanonicalJsonError';
}

export function canonicalJSON(value: unknown): string {
  const out: string[] = [];
  write(value, out, new Set<object>(), '$');
  return out.join('');
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, out: string[], ancestors: Set<object>, path: string): void {
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`canonicalJSON: non-finite number at ${path}`);
      }
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`canonicalJSON: unsupported ${typeof value} at ${path}`);
  }

  if (value === null) {
    out.push('null');
    return;
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonError(`canonicalJSON: cycle at ${path}`);
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i += 1) {
      const item: unknown = value[i];
      if (item === undefined) {
        throw new CanonicalJsonError(`canonicalJSON: undefined array element at ${path}[${i}]`);
      }
      if (i > 0) out.push(',');
      write(item, out, ancestors, `${path}[${i}]`);
    }
    out.push(']');
  } else if (isPlainObject(value)) {
    out.push('{');
    let first = true;
    for (const key of Object.keys(value).sort()) {
      const member = value[key];
      if (member === undefined) continue;
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(key), ':');
      write(member, out, ancestors, `${path}.${key}`);
    }
    out.push('}');
  } else {
    const kind = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    throw new CanonicalJsonError(`canonicalJSON: non-plain object (${kind}) at ${path}`);
  }

  ancestors.delete(value);
}
