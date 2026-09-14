/**
 * What an export scans, and how hits are applied (SPEC-011 export flow steps 2 and 4; SPEC-003 "Export").
 *
 * Detection belongs to Redaction. Every piece of bundle content goes through S02's scanBundle(), one file
 * per call so each hit can be attributed and applied, and every hit is replaced with Redaction's own
 * marker. Nothing here decides what a secret is.
 *
 * Verified identifiers are masked before scanning (SPEC-011 challenge 01a09d3a; Q-015 fallback). The
 * high-entropy detector flags every sha256, git sha, event id and run id. Redacting those would destroy
 * the hash chain, the blob addresses and the refs of every bundle, so no bundle could ever be imported.
 * A value is masked only when it is one of these:
 * - a value the caller's rule vouches for because it was verified: an event's hash / prev_hash (chain
 *   verified), a sha256 inside a `{sha256, size}` that addresses a stored blob, a checkpoint's
 *   workspace_commit / state_hash checked against its ref and state blob;
 * - a whole string in a generated-id format no credential has: `run_<ulid>`, `c_<n>`, `evt_<uuid>`.
 * A masked value is replaced by the same number of `*`, a character no detector reads as part of a
 * token, so offsets in the masked text are offsets in the real bytes. Everything else is scanned and
 * redacted, including every other hex or base64 string.
 */
import { canonicalJSON } from '../ledger/canonical-json.js';
import { redactionMarker } from '../redact/detectors.js';
import { scanBundle, type RedactionHit } from '../redact/index.js';
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN } from '../storage/layout.js';
import { isRecord } from './records.js';

export const EVENT_ID_PATTERN = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** scanBundle's kind for a file whose path isExcludedPath() rejects. */
export const EXCLUDED_PATH_KIND = 'excluded_path';

const MASK = '*';
/** Printable ASCII other than `"` and `\`: exactly one byte per character inside a JSON string. */
const MASKABLE = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

export type JsonPath = readonly (string | number)[];

/** True when the string at `path` (whose containing object or array is `parent`) is a verified identifier. */
export type ExemptRule = (path: JsonPath, value: string, parent: unknown) => boolean;

export const NO_EXEMPTIONS: ExemptRule = () => false;

export function isGeneratedId(value: string): boolean {
  return RUN_ID_PATTERN.test(value) || CHECKPOINT_ID_PATTERN.test(value) || EVENT_ID_PATTERN.test(value);
}

function masked(value: unknown, path: (string | number)[], parent: unknown, rule: ExemptRule): unknown {
  if (typeof value === 'string') {
    const exempt = MASKABLE.test(value) && (isGeneratedId(value) || rule(path, value, parent));
    return exempt ? MASK.repeat(value.length) : value;
  }
  if (Array.isArray(value)) return value.map((item, i) => masked(item, [...path, i], value, rule));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = masked(child, [...path, key], value, rule);
    return out;
  }
  return value;
}

/** One file of bundle content: its bytes as written, and the same bytes with verified identifiers masked. */
export interface ScanSubject {
  /** The path Redaction sees (isExcludedPath applies to it). */
  readonly path: string;
  readonly bytes: Buffer;
  /** Same length as `bytes`. */
  readonly scanned: Buffer;
}

export function rawSubject(path: string, bytes: Buffer): ScanSubject {
  return { path, bytes, scanned: bytes };
}

/**
 * JSON documents serialized as canonical JSON, each followed by `lineEnd` (a ledger is one event per
 * line; a blob or record is a single document). A document whose masked form would not keep its byte
 * length is scanned unmasked, which can only add hits.
 */
export function jsonSubject(path: string, documents: ReadonlyArray<{ readonly value: unknown; readonly rule: ExemptRule }>, lineEnd: string): ScanSubject {
  const real: Buffer[] = [];
  const scan: Buffer[] = [];
  for (const { value, rule } of documents) {
    const line = Buffer.from(`${canonicalJSON(value)}${lineEnd}`, 'utf8');
    const maskedLine = Buffer.from(`${canonicalJSON(masked(value, [], undefined, rule))}${lineEnd}`, 'utf8');
    real.push(line);
    scan.push(maskedLine.byteLength === line.byteLength ? maskedLine : line);
  }
  return { path, bytes: Buffer.concat(real), scanned: Buffer.concat(scan) };
}

/** Redaction's scan of one subject. Hit offsets are byte offsets within `subject.bytes`. */
export async function scanSubject(subject: ScanSubject): Promise<RedactionHit[]> {
  async function* one(): AsyncGenerator<{ path: string; bytes: Uint8Array }> {
    yield { path: subject.path, bytes: subject.scanned };
  }
  return (await scanBundle(one())).hits;
}

/** Replace every hit span with Redaction's marker. Overlapping spans become one marker (the earliest kind). */
export function applyRedactions(bytes: Buffer, hits: readonly RedactionHit[]): Buffer {
  const spans = hits
    .filter((hit) => hit.length > 0)
    .map((hit) => ({ kind: hit.kind, start: hit.offset, end: Math.min(bytes.byteLength, hit.offset + hit.length) }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  if (spans.length === 0) return bytes;

  const parts: Buffer[] = [];
  let cursor = 0;
  let current: { kind: string; start: number; end: number } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    parts.push(bytes.subarray(cursor, current.start), Buffer.from(redactionMarker(current.kind), 'utf8'));
    cursor = current.end;
    current = undefined;
  };
  for (const span of spans) {
    if (current !== undefined && span.start < current.end) {
      current.end = Math.max(current.end, span.end);
      continue;
    }
    flush();
    current = { ...span };
  }
  flush();
  parts.push(bytes.subarray(cursor));
  return Buffer.concat(parts);
}

const TOOL_IO_EVENT_TYPES: ReadonlySet<string> = new Set(['tool.requested', 'tool.completed', 'tool.failed']);

/** A ledger event that carries a tool request, stdout or stderr (SPEC-003 "Tool I/O"). */
export function isToolOutputEvent(type: string): boolean {
  return TOOL_IO_EVENT_TYPES.has(type);
}

const ENV_CLASSIFICATIONS: ReadonlySet<string> = new Set(['secret', 'safe', 'unknown']);

/** Number of classifyEnv()-shaped entries `{name, classification, value, fingerprint}` inside `value`. */
export function countEnvEntries(value: unknown): number {
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) count += countEnvEntries(item);
  } else if (isRecord(value)) {
    const classification = value['classification'];
    if (
      typeof value['name'] === 'string' &&
      typeof classification === 'string' &&
      ENV_CLASSIFICATIONS.has(classification) &&
      typeof value['fingerprint'] === 'string' &&
      'value' in value
    ) {
      count += 1;
    }
    for (const child of Object.values(value)) count += countEnvEntries(child);
  }
  return count;
}
