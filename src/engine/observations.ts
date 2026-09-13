/**
 * Observation sanitization: the engine's single boundary between captured data and the ledger
 * (SPEC-003 "no code path may turn an unsanitized tool result or env capture into a durable artifact").
 *
 * Every string in an observation payload, keys included, goes through Redaction's `sanitize()` BEFORE the
 * draft reaches storage (where it is hashed and persisted). On top of that, the SPEC-002 payload limits
 * that apply to observations:
 * - Tool output: any string in a `tool.*` payload longer than 50 MB (UTF-8) is truncated to 50 MB after
 *   redaction. The payload then carries `truncated: true` and `original_bytes: {<JSON pointer>: n}`.
 * - Env capture: a payload member `env` holding a string map is replaced by `classifyEnv()` entries
 *   (secret values nulled with a fingerprint; values over 64 KB truncated, fingerprint of the full value).
 * - Inline payload over 1 MB: handled by the ledger, which stores the payload as a CAS blob.
 *
 * Correlation ids (`tool_call_id`, `side_effect_id`) are matched between requests and acknowledgements
 * (SPEC-004 resume rule). A redaction marker would make different ids equal, so an id the scanner flags
 * is replaced by its sha256 fingerprint instead: still unique, still never the raw value.
 */
import { INTENT_ID_KEYS } from '../ledger/pending-intent.js';
import type { JsonPayload } from '../model/types.js';
import { fingerprint } from '../redact/fingerprint.js';
import { classifyEnv, sanitize } from '../redact/index.js';
import { EngineError } from './errors.js';

/** SPEC-002 "Tool output: 50 MB". */
export const MAX_TOOL_OUTPUT_BYTES = 50 * 1024 * 1024;

const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set(['tool.requested', 'tool.completed', 'tool.failed']);
const CORRELATION_KEYS: ReadonlySet<string> = new Set(Object.values(INTENT_ID_KEYS));

interface WalkContext {
  readonly truncate: boolean;
  readonly originalBytes: Record<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function pointerToken(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Cut `value` to at most `maxBytes` UTF-8 bytes without leaving a partial character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}

function sanitizeString(value: string, pointer: string, ctx: WalkContext): string {
  const { output } = sanitize(value);
  // Redact the full value first, so a secret straddling the cut is still seen; then apply the limit.
  if (ctx.truncate && output.length > MAX_TOOL_OUTPUT_BYTES / 4 && Buffer.byteLength(output, 'utf8') > MAX_TOOL_OUTPUT_BYTES) {
    ctx.originalBytes[pointer === '' ? '/' : pointer] = Buffer.byteLength(value, 'utf8');
    return truncateUtf8(output, MAX_TOOL_OUTPUT_BYTES);
  }
  return output;
}

function walk(value: unknown, pointer: string, ctx: WalkContext): unknown {
  if (typeof value === 'string') return sanitizeString(value, pointer, ctx);
  if (Array.isArray(value)) return value.map((item, i) => walk(item, `${pointer}/${i}`, ctx));
  if (isPlainObject(value)) return walkObject(value, pointer, ctx);
  // numbers, booleans, null; anything that is not JSON is rejected by the ledger's canonical JSON.
  return value;
}

function walkObject(value: Record<string, unknown>, pointer: string, ctx: WalkContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, child] of Object.entries(value)) {
    const key = sanitize(rawKey).output;
    if (key === 'env' && isStringMap(child)) {
      out[key] = classifyEnv(child);
    } else if (CORRELATION_KEYS.has(key) && typeof child === 'string') {
      out[key] = sanitize(child).hits.length === 0 ? child : fingerprint(child);
    } else {
      out[key] = walk(child, `${pointer}/${pointerToken(key)}`, ctx);
    }
  }
  return out;
}

/** A sanitized copy of an observation payload, ready to be appended. The input is not modified. */
export function sanitizePayload(type: string, payload: unknown): JsonPayload {
  if (!isPlainObject(payload)) {
    throw new EngineError('ERR_INVALID_INPUT', `the payload of a ${JSON.stringify(type)} observation must be a JSON object`);
  }
  const ctx: WalkContext = { truncate: TOOL_EVENT_TYPES.has(type), originalBytes: {} };
  const out = walkObject(payload, '', ctx);
  if (Object.keys(ctx.originalBytes).length > 0) {
    out['truncated'] = true;
    out['original_bytes'] = ctx.originalBytes;
  }
  return out;
}
