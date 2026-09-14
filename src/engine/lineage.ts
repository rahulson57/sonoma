/**
 * Engine-authored lineage payloads (DEC-024). `agent.resumed`, `agent.rolled_back` and `agent.forked` are
 * appended WITHOUT sanitize(), whose high-entropy detector would redact the commit ids lineage depends on.
 * That exemption holds only because every payload is checked here, before anything is written (no worktree,
 * no forked run, no ledger append), against an exact per-event-type schema:
 * - exactly the schema's keys: an unknown, missing, symbol or accessor key is rejected;
 * - every value matches the pattern of ITS OWN field: a run id where a run id belongs, a checkpoint id where
 *   a checkpoint id belongs, a commit id of the repository's object format (40 hex for sha1, 64 hex for
 *   sha256), a non-negative safe integer for seqs and counts. No field can carry free text.
 * Rejections never echo the offending key or value, which may be a secret.
 *
 * `run.created` is not in this table: its `agent` is caller-supplied free text, so the engine sanitizes it.
 */
import type { JsonPayload } from '../model/types.js';
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN } from '../storage/layout.js';
import { EngineError } from './errors.js';
import type { ObjectFormat } from './snapshot.js';

export type LineageFieldKind = 'run_id' | 'checkpoint_id' | 'commit' | 'seq' | 'count';

export const LINEAGE_SCHEMAS = {
  'agent.resumed': { checkpoint_id: 'checkpoint_id', ledger_seq: 'seq', workspace_commit: 'commit' },
  'agent.rolled_back': { checkpoint_id: 'checkpoint_id', ledger_seq: 'seq', workspace_commit: 'commit', side_effect_warnings: 'count' },
  'agent.forked': { parent_run_id: 'run_id', forked_from_checkpoint: 'checkpoint_id', ledger_seq: 'seq', workspace_commit: 'commit' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, LineageFieldKind>>>>;

export type LineageEventType = keyof typeof LINEAGE_SCHEMAS;

const COMMIT_BY_FORMAT: Readonly<Record<ObjectFormat, RegExp>> = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function matches(kind: LineageFieldKind, value: unknown, objectFormat: ObjectFormat): boolean {
  switch (kind) {
    case 'run_id':
      return typeof value === 'string' && RUN_ID_PATTERN.test(value);
    case 'checkpoint_id':
      return typeof value === 'string' && CHECKPOINT_ID_PATTERN.test(value);
    case 'commit':
      return typeof value === 'string' && COMMIT_BY_FORMAT[objectFormat].test(value);
    case 'seq':
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
}

function describeKind(kind: LineageFieldKind, objectFormat: ObjectFormat): string {
  switch (kind) {
    case 'run_id':
      return 'run id';
    case 'checkpoint_id':
      return 'checkpoint id';
    case 'commit':
      return `${objectFormat} commit id`;
    case 'seq':
    case 'count':
      return 'non-negative integer';
  }
}

function rejected(type: string, detail: string): EngineError {
  return new EngineError('ERR_CORRUPT', `refusing to append ${type}: ${detail}`);
}

/**
 * Validate a lineage payload against its event type's schema and return a fresh copy holding exactly the
 * schema's fields. Throws ERR_CORRUPT (the values come from durable records that should never fail these
 * patterns) and writes nothing.
 */
export function lineagePayload(type: LineageEventType, fields: unknown, objectFormat: ObjectFormat): JsonPayload {
  if (typeof type !== 'string' || !hasOwn(LINEAGE_SCHEMAS, type)) {
    throw rejected('a lineage event', 'unknown lineage event type');
  }
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw rejected(type, 'unknown object format');
  const schema: Readonly<Record<string, LineageFieldKind>> = LINEAGE_SCHEMAS[type];
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields) || Object.getPrototypeOf(fields) !== Object.prototype) {
    throw rejected(type, 'the payload is not a plain object');
  }
  const allowed = Object.keys(schema);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string' || !hasOwn(schema, key)) {
      throw rejected(type, `unexpected key (allowed: ${allowed.join(', ')})`);
    }
  }
  const out: Record<string, string | number> = {};
  for (const [key, kind] of Object.entries(schema)) {
    const descriptor = Object.getOwnPropertyDescriptor(fields, key);
    if (descriptor === undefined) throw rejected(type, `missing ${key}`);
    if (!('value' in descriptor) || !matches(kind, descriptor.value, objectFormat)) {
      throw rejected(type, `${key} is not a ${describeKind(kind, objectFormat)}`);
    }
    out[key] = descriptor.value as string | number;
  }
  return out;
}
