/**
 * Store records shared by export and import: the run record, the checkpoints a ledger declares, and
 * BlobRef-shaped values inside payloads.
 */
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../ledger/canonical-json.js';
import type { BlobRef, Checkpoint, LedgerEvent, Run } from '../model/types.js';
import { validateCheckpoint } from '../model/validate.js';
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN } from '../storage/layout.js';

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A run record exactly as Local Storage writes it (`runs/<run>/run.json`), or undefined. */
export function parseRunRecord(text: string, runId: string): Run | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).length !== 5) return undefined;
  const runIdValue = value['run_id'];
  const parent = value['parent_run_id'];
  const forkedFrom = value['forked_from_checkpoint'];
  const agent = value['agent'];
  const createdAt = value['created_at'];
  if (runIdValue !== runId || typeof agent !== 'string' || typeof createdAt !== 'string') return undefined;
  if (!(parent === null || (typeof parent === 'string' && RUN_ID_PATTERN.test(parent)))) return undefined;
  if (!(forkedFrom === null || (typeof forkedFrom === 'string' && CHECKPOINT_ID_PATTERN.test(forkedFrom)))) return undefined;
  return { run_id: runId, parent_run_id: parent, forked_from_checkpoint: forkedFrom, agent, created_at: createdAt };
}

/** The file bytes Local Storage writes for a run record. */
export function runRecordText(run: Run): string {
  return `${canonicalJSON(run)}\n`;
}

/**
 * Checkpoints declared by `checkpoint.created` events, under the rule Local Storage's reindex applies:
 * a valid record for the event's own run, whose ledger_seq is that event's seq. First declaration wins.
 */
export function checkpointsFromLedger(events: readonly LedgerEvent[]): Checkpoint[] {
  const out: Checkpoint[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'checkpoint.created') continue;
    const valid = validateCheckpoint(event.payload);
    if (!valid.ok) continue;
    const checkpoint = valid.value;
    if (checkpoint.run_id !== event.run_id || checkpoint.ledger_seq !== event.seq || seen.has(checkpoint.checkpoint_id)) continue;
    seen.add(checkpoint.checkpoint_id);
    out.push(checkpoint);
  }
  return out;
}

export function blobKey(ref: BlobRef): string {
  return `${ref.sha256}:${ref.size}`;
}

/** Exactly `{sha256, size}` with a sha256 hex digest and a non-negative integer size. */
export function isBlobRefShape(value: unknown): value is BlobRef {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const sha = value['sha256'];
  const size = value['size'];
  return typeof sha === 'string' && SHA256_HEX.test(sha) && typeof size === 'number' && Number.isInteger(size) && size >= 0;
}

/** Every BlobRef-shaped value anywhere inside `value`, keyed by blobKey. */
export function collectBlobRefs(value: unknown, out: Map<string, BlobRef> = new Map()): Map<string, BlobRef> {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, out);
  } else if (isRecord(value)) {
    if (isBlobRefShape(value)) out.set(blobKey(value), { sha256: value.sha256, size: value.size });
    for (const child of Object.values(value)) collectBlobRefs(child, out);
  }
  return out;
}

/** The value of canonical JSON bytes, or undefined when the bytes are not exactly canonical JSON. */
export function parseCanonicalJson(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  try {
    const value: unknown = JSON.parse(text);
    return canonicalJSON(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}
