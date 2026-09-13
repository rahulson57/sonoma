/**
 * A deliberately small JSON Schema (draft 2020-12) validator for the files under `schema/`.
 *
 * Why in-repo: the project has no validator dependency, and `package.json` is owned by the
 * scaffold section (SPEC-001). This implements ONLY the keywords the ckpt schemas use. Any other
 * keyword makes `SchemaRegistry.add` throw, so a schema can never quietly rely on a rule that is
 * not enforced. The schema files stay standard 2020-12: a full validator can replace this later
 * without editing them.
 *
 * Supported: $schema, $id (root only), $defs, $ref (JSON-pointer fragments, same-document or
 * relative/absolute to another registered $id), $comment, title, description, default (annotation
 * only), type, enum, const, properties, required, additionalProperties, items, minItems, maxItems,
 * minLength, pattern, minimum, maximum, anyOf.
 *
 * Values are judged as JSON: an object member whose value is `undefined` counts as absent, and
 * `object` means a plain object (not an array, Date, Map…). References are resolved only against
 * registered schemas. Nothing is ever fetched.
 */

export const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export interface SchemaIssue {
  /** JSON pointer to the offending value; `''` is the root. */
  readonly path: string;
  readonly message: string;
}

export type SchemaValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

/** The schema itself is unusable: unsupported keyword, malformed keyword value, bad $ref. */
export class SchemaDefinitionError extends Error {
  override readonly name = 'SchemaDefinitionError';
}

type SchemaObject = { readonly [keyword: string]: unknown };
type SchemaNode = boolean | SchemaObject;

interface Root {
  readonly id: string;
  readonly schema: SchemaObject;
}

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  '$comment',
  'title',
  'description',
  'default',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'pattern',
  'minimum',
  'maximum',
  'anyOf',
]);

const TYPE_NAMES: ReadonlySet<string> = new Set(['null', 'boolean', 'string', 'number', 'integer', 'array', 'object']);

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pointerToken(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  if (typeof value === 'object' && !isPlainObject(value)) return 'non-plain object';
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const aKeys = Object.keys(ar).filter((k) => ar[k] !== undefined);
  const bKeys = Object.keys(br).filter((k) => br[k] !== undefined);
  return aKeys.length === bKeys.length && aKeys.every((k) => hasOwn(br, k) && jsonEqual(ar[k], br[k]));
}

export class SchemaRegistry {
  readonly #roots = new Map<string, Root>();
  readonly #patterns = new Map<string, RegExp>();

  /** Register a root schema. Returns its normalised `$id`. Throws SchemaDefinitionError. */
  add(schema: unknown): string {
    if (!isRecord(schema)) throw new SchemaDefinitionError('a root schema must be a JSON object');
    if (schema['$schema'] !== DRAFT_2020_12) {
      throw new SchemaDefinitionError(`root schema must declare "$schema": "${DRAFT_2020_12}"`);
    }
    const rawId = schema['$id'];
    let id: string;
    try {
      if (typeof rawId !== 'string') throw new TypeError('not a string');
      id = new URL(rawId).href;
    } catch {
      throw new SchemaDefinitionError(`root schema must declare an absolute "$id", got ${JSON.stringify(rawId)}`);
    }
    if (this.#roots.has(id)) throw new SchemaDefinitionError(`schema ${id} is already registered`);
    this.#check(schema, id, true);
    this.#roots.set(id, { id, schema });
    return id;
  }

  has(id: string): boolean {
    return this.#roots.has(id);
  }

  validate(id: string, value: unknown): SchemaValidation {
    const root = this.#roots.get(id);
    if (!root) throw new SchemaDefinitionError(`no schema registered with $id ${id}`);
    const issues: SchemaIssue[] = [];
    this.#validate(root.schema, value, root, '', issues);
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  #regex(pattern: string, at: string): RegExp {
    let re = this.#patterns.get(pattern);
    if (!re) {
      try {
        re = new RegExp(pattern, 'u');
      } catch (err) {
        throw new SchemaDefinitionError(`${at}: invalid pattern ${JSON.stringify(pattern)} (${(err as Error).message})`);
      }
      this.#patterns.set(pattern, re);
    }
    return re;
  }

  #check(node: unknown, at: string, isRoot: boolean): void {
    if (typeof node === 'boolean') return;
    if (!isRecord(node)) throw new SchemaDefinitionError(`${at}: a schema must be an object or a boolean`);
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        throw new SchemaDefinitionError(`${at}: unsupported keyword "${key}" (see src/model/json-schema.ts)`);
      }
    }
    if (!isRoot && (hasOwn(node, '$id') || hasOwn(node, '$schema'))) {
      throw new SchemaDefinitionError(`${at}: "$id" and "$schema" are only supported on the root schema`);
    }
    if (hasOwn(node, 'type')) {
      const type = node['type'];
      const list: unknown[] = Array.isArray(type) ? type : [type];
      if (list.length === 0 || !list.every((t) => typeof t === 'string' && TYPE_NAMES.has(t))) {
        throw new SchemaDefinitionError(`${at}: invalid "type" ${JSON.stringify(type)}`);
      }
    }
    if (hasOwn(node, 'enum') && !(Array.isArray(node['enum']) && node['enum'].length > 0)) {
      throw new SchemaDefinitionError(`${at}: "enum" must be a non-empty array`);
    }
    if (hasOwn(node, 'required')) {
      const required = node['required'];
      if (!Array.isArray(required) || !required.every((r) => typeof r === 'string')) {
        throw new SchemaDefinitionError(`${at}: "required" must be an array of strings`);
      }
    }
    for (const key of ['minItems', 'maxItems', 'minLength']) {
      if (hasOwn(node, key)) {
        const n = node[key];
        if (!(typeof n === 'number' && Number.isInteger(n) && n >= 0)) {
          throw new SchemaDefinitionError(`${at}: "${key}" must be a non-negative integer`);
        }
      }
    }
    for (const key of ['minimum', 'maximum']) {
      if (hasOwn(node, key) && !(typeof node[key] === 'number' && Number.isFinite(node[key]))) {
        throw new SchemaDefinitionError(`${at}: "${key}" must be a finite number`);
      }
    }
    if (hasOwn(node, 'pattern')) {
      const pattern = node['pattern'];
      if (typeof pattern !== 'string') throw new SchemaDefinitionError(`${at}: "pattern" must be a string`);
      this.#regex(pattern, at);
    }
    if (hasOwn(node, '$ref') && typeof node['$ref'] !== 'string') {
      throw new SchemaDefinitionError(`${at}: "$ref" must be a string`);
    }
    for (const key of ['properties', '$defs']) {
      if (!hasOwn(node, key)) continue;
      const children = node[key];
      if (!isRecord(children)) throw new SchemaDefinitionError(`${at}: "${key}" must be an object`);
      for (const [name, child] of Object.entries(children)) {
        this.#check(child, `${at}/${key}/${pointerToken(name)}`, false);
      }
    }
    for (const key of ['items', 'additionalProperties']) {
      if (hasOwn(node, key)) this.#check(node[key], `${at}/${key}`, false);
    }
    if (hasOwn(node, 'anyOf')) {
      const branches = node['anyOf'];
      if (!Array.isArray(branches) || branches.length === 0) {
        throw new SchemaDefinitionError(`${at}: "anyOf" must be a non-empty array`);
      }
      branches.forEach((branch, i) => this.#check(branch, `${at}/anyOf/${i}`, false));
    }
  }

  #resolve(ref: string, from: Root): { root: Root; node: SchemaNode } {
    const hashAt = ref.indexOf('#');
    const uri = hashAt === -1 ? ref : ref.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : ref.slice(hashAt + 1);
    let root = from;
    if (uri !== '') {
      const found = this.#roots.get(new URL(uri, from.id).href);
      if (!found) throw new SchemaDefinitionError(`unresolvable $ref "${ref}" from ${from.id}`);
      root = found;
    }
    let node: unknown = root.schema;
    if (fragment !== '') {
      if (!fragment.startsWith('/')) {
        throw new SchemaDefinitionError(`$ref "${ref}": only JSON-pointer fragments are supported`);
      }
      for (const raw of fragment.slice(1).split('/')) {
        const token = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
        if (!isRecord(node) || !hasOwn(node, token)) {
          throw new SchemaDefinitionError(`unresolvable $ref "${ref}" from ${from.id}`);
        }
        node = node[token];
      }
    }
    if (typeof node !== 'boolean' && !isRecord(node)) {
      throw new SchemaDefinitionError(`$ref "${ref}" does not point at a schema`);
    }
    return { root, node };
  }

  #validate(node: SchemaNode, value: unknown, root: Root, path: string, issues: SchemaIssue[]): void {
    if (node === true) return;
    if (node === false) {
      issues.push({ path, message: 'no value is allowed here' });
      return;
    }

    const ref = node['$ref'];
    if (typeof ref === 'string') {
      const target = this.#resolve(ref, root);
      this.#validate(target.node, value, target.root, path, issues);
    }

    if (hasOwn(node, 'type')) {
      const type = node['type'];
      const list = (Array.isArray(type) ? type : [type]) as string[];
      if (!list.some((t) => matchesType(t, value))) {
        issues.push({ path, message: `expected ${list.join(' or ')}, got ${describe(value)}` });
        return;
      }
    }

    if (hasOwn(node, 'const') && !jsonEqual(value, node['const'])) {
      issues.push({ path, message: `must equal ${JSON.stringify(node['const'])}` });
    }
    const allowed = node['enum'];
    if (Array.isArray(allowed) && !allowed.some((candidate) => jsonEqual(value, candidate))) {
      issues.push({ path, message: `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}` });
    }

    if (typeof value === 'string') {
      const minLength = node['minLength'];
      if (typeof minLength === 'number' && [...value].length < minLength) {
        issues.push({ path, message: `must be at least ${minLength} characters` });
      }
      const pattern = node['pattern'];
      if (typeof pattern === 'string' && !this.#regex(pattern, path).test(value)) {
        issues.push({ path, message: `does not match pattern ${pattern}` });
      }
    }

    if (typeof value === 'number') {
      const minimum = node['minimum'];
      if (typeof minimum === 'number' && value < minimum) issues.push({ path, message: `must be >= ${minimum}` });
      const maximum = node['maximum'];
      if (typeof maximum === 'number' && value > maximum) issues.push({ path, message: `must be <= ${maximum}` });
    }

    if (Array.isArray(value)) {
      const minItems = node['minItems'];
      if (typeof minItems === 'number' && value.length < minItems) {
        issues.push({ path, message: `must have at least ${minItems} item(s)` });
      }
      const maxItems = node['maxItems'];
      if (typeof maxItems === 'number' && value.length > maxItems) {
        issues.push({ path, message: `must have at most ${maxItems} item(s)` });
      }
      if (hasOwn(node, 'items')) {
        const items = node['items'] as SchemaNode;
        value.forEach((item, i) => this.#validate(items, item, root, `${path}/${i}`, issues));
      }
    }

    if (isPlainObject(value)) {
      const required = node['required'];
      if (Array.isArray(required)) {
        for (const name of required as string[]) {
          if (!hasOwn(value, name) || value[name] === undefined) {
            issues.push({ path, message: `missing required property "${name}"` });
          }
        }
      }
      const properties = isRecord(node['properties']) ? node['properties'] : undefined;
      const hasAdditional = hasOwn(node, 'additionalProperties');
      for (const [key, member] of Object.entries(value)) {
        if (member === undefined) continue;
        const memberPath = `${path}/${pointerToken(key)}`;
        if (properties && hasOwn(properties, key)) {
          this.#validate(properties[key] as SchemaNode, member, root, memberPath, issues);
        } else if (hasAdditional) {
          const additional = node['additionalProperties'] as SchemaNode;
          if (additional === false) {
            issues.push({ path: memberPath, message: `unknown property "${key}"` });
          } else {
            this.#validate(additional, member, root, memberPath, issues);
          }
        }
      }
    }

    const anyOf = node['anyOf'];
    if (Array.isArray(anyOf)) {
      const failures: string[] = [];
      let matched = false;
      for (const branch of anyOf as SchemaNode[]) {
        const branchIssues: SchemaIssue[] = [];
        this.#validate(branch, value, root, path, branchIssues);
        if (branchIssues.length === 0) {
          matched = true;
          break;
        }
        failures.push(branchIssues.map((i) => `${i.path === '' ? '/' : i.path} ${i.message}`).join('; '));
      }
      if (!matched) {
        issues.push({
          path,
          message: `must match at least one of ${anyOf.length} alternatives: ${failures.map((f, i) => `[${i + 1}] ${f}`).join(' | ')}`,
        });
      }
    }
  }
}
