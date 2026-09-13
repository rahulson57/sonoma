/**
 * Execution Ledger append (SPEC-004): turns event drafts into sealed, hash-chained, immutable events.
 *
 * - `seq` is assigned here: contiguous and strictly increasing per run, starting at 1.
 * - `hash = sha256(prev_hash ‖ canonicalJSON(event without hash))`; seq 1 chains from GENESIS_PREV_HASH.
 * - A payload whose canonical JSON is over MAX_INLINE_PAYLOAD_BYTES (1 MiB, SPEC-002 payload limits)
 *   is written to the injected BlobSink as those canonical bytes. The event then carries
 *   `payload_ref` and `payload: null`.
 * - Appends to one ledger are serialised, so concurrent callers still get one contiguous chain
 *   (a single writer per run, SPEC-002).
 * - Returned events are deep-frozen. There is no API to change or remove one.
 *
 * Deliberately NOT here:
 * - Persistence. Local Storage stores the sealed event.
 * - Sanitization. The Checkpoint Engine runs Redaction before a draft reaches the ledger (SPEC-003);
 *   the ledger hashes and keeps the payload verbatim.
 * - The blob store itself. BlobSink is Local Storage's `putBlob`.
 */
import { randomUUID } from 'node:crypto';
import { validateEvent } from '../model/validate.js';
import type { BlobRef, LedgerEvent, LedgerEventDraft } from '../model/types.js';
import { canonicalJSON } from './canonical-json.js';
import { isLedgerActor, isLedgerEventType } from './event-types.js';
import { GENESIS_PREV_HASH, SHA256_HEX, chainHash, sha256Hex } from './hash.js';

/** SPEC-002 "Inline event payload: 1 MB": measured as UTF-8 bytes of the payload's canonical JSON. */
export const MAX_INLINE_PAYLOAD_BYTES = 1024 * 1024;

/** Where over-limit payloads go: content-addressed, deduplicated (Local Storage `putBlob`). */
export interface BlobSink {
  putBlob(data: Uint8Array): Promise<BlobRef>;
}

export interface LedgerClock {
  /** Epoch milliseconds. */
  now(): number;
}

/** The last sealed event of a run: what the next append chains from. */
export interface LedgerHead {
  readonly seq: number;
  readonly hash: string;
}

/** Head of a run with no events yet. */
export const GENESIS_HEAD: LedgerHead = Object.freeze({ seq: 0, hash: GENESIS_PREV_HASH });

export type LedgerErrorCode =
  | 'ERR_INVALID_DRAFT'
  | 'ERR_UNKNOWN_EVENT_TYPE'
  | 'ERR_UNKNOWN_ACTOR'
  | 'ERR_RUN_MISMATCH'
  | 'ERR_INVALID_PAYLOAD'
  | 'ERR_BLOB_REF_MISMATCH'
  | 'ERR_INVALID_EVENT'
  | 'ERR_INVALID_HEAD'
  | 'ERR_INVALID_CLOCK';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface ExecutionLedgerOptions {
  readonly run_id: string;
  readonly blobs: BlobSink;
  /** Defaults to the system clock. Tests inject tests/helpers/clock.ts. */
  readonly clock?: LedgerClock;
  /** Defaults to `evt_<uuid>`. */
  readonly newEventId?: () => string;
  /** Continue an existing chain (e.g. a run re-opened from storage). Defaults to GENESIS_HEAD. */
  readonly head?: LedgerHead;
}

const DRAFT_KEYS: ReadonlySet<string> = new Set(['run_id', 'type', 'actor', 'payload']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class ExecutionLedger {
  readonly #runId: string;
  readonly #blobs: BlobSink;
  readonly #clock: LedgerClock;
  readonly #newEventId: () => string;
  #head: LedgerHead;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ExecutionLedgerOptions) {
    const head = options.head ?? GENESIS_HEAD;
    const consistent =
      Number.isInteger(head.seq) &&
      head.seq >= 0 &&
      typeof head.hash === 'string' &&
      SHA256_HEX.test(head.hash) &&
      (head.seq > 0 || head.hash === GENESIS_PREV_HASH);
    if (!consistent) {
      throw new LedgerError('ERR_INVALID_HEAD', `head ${JSON.stringify(head)} is not a valid chain position`);
    }
    this.#runId = options.run_id;
    this.#blobs = options.blobs;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#newEventId = options.newEventId ?? (() => `evt_${randomUUID()}`);
    this.#head = Object.freeze({ seq: head.seq, hash: head.hash });
  }

  get runId(): string {
    return this.#runId;
  }

  get head(): LedgerHead {
    return this.#head;
  }

  /**
   * Seal and return the next event. Rejects with LedgerError (the head does not move) on an
   * unknown type or actor, a draft for another run, a payload that is not a JSON object, or a
   * blob sink whose reference does not match the bytes it was given.
   */
  append(draft: LedgerEventDraft): Promise<LedgerEvent> {
    const sealed = this.#tail.then(() => this.#seal(draft));
    this.#tail = sealed.catch(() => undefined);
    return sealed;
  }

  async #seal(draft: LedgerEventDraft): Promise<LedgerEvent> {
    if (!isPlainObject(draft)) throw new LedgerError('ERR_INVALID_DRAFT', 'a draft must be an object');
    const extra = Object.keys(draft).filter((key) => !DRAFT_KEYS.has(key));
    if (extra.length > 0) {
      throw new LedgerError(
        'ERR_INVALID_DRAFT',
        `drafts carry only run_id, type, actor and payload; the ledger assigns the rest (got ${extra.join(', ')})`,
      );
    }
    const type: unknown = draft.type;
    const actor: unknown = draft.actor;
    if (!isLedgerEventType(type)) {
      throw new LedgerError('ERR_UNKNOWN_EVENT_TYPE', `${JSON.stringify(type)} is not a v1 ledger event type`);
    }
    if (!isLedgerActor(actor)) {
      throw new LedgerError('ERR_UNKNOWN_ACTOR', `${JSON.stringify(actor)} is not agent, runtime or human`);
    }
    if (draft.run_id !== this.#runId) {
      throw new LedgerError('ERR_RUN_MISMATCH', `draft for ${JSON.stringify(draft.run_id)} appended to ledger of ${this.#runId}`);
    }
    if (!isPlainObject(draft.payload)) {
      throw new LedgerError('ERR_INVALID_PAYLOAD', 'payload must be a JSON object');
    }

    let text: string;
    try {
      text = canonicalJSON(draft.payload);
    } catch (err) {
      throw new LedgerError('ERR_INVALID_PAYLOAD', (err as Error).message);
    }

    let payload: Record<string, unknown> | null = null;
    let payload_ref: BlobRef | null = null;
    if (Buffer.byteLength(text, 'utf8') > MAX_INLINE_PAYLOAD_BYTES) {
      const bytes = Buffer.from(text, 'utf8');
      const ref = await this.#blobs.putBlob(bytes);
      if (!ref || ref.sha256 !== sha256Hex(bytes) || ref.size !== bytes.byteLength) {
        throw new LedgerError('ERR_BLOB_REF_MISMATCH', 'the blob sink returned a reference that does not match the payload bytes');
      }
      payload_ref = { sha256: ref.sha256, size: ref.size };
    } else {
      // A private copy of exactly what is hashed: later changes to the caller's object cannot alter the event.
      payload = JSON.parse(text) as Record<string, unknown>;
    }

    const now = this.#clock.now();
    if (!Number.isFinite(now)) throw new LedgerError('ERR_INVALID_CLOCK', `clock returned ${String(now)}`);

    const head = this.#head;
    const body = {
      event_id: this.#newEventId(),
      run_id: this.#runId,
      seq: head.seq + 1,
      ts: new Date(now).toISOString(),
      type,
      actor,
      payload,
      payload_ref,
      prev_hash: head.hash,
    };
    const event: LedgerEvent = { ...body, hash: chainHash(head.hash, body) };

    const valid = validateEvent(event);
    if (!valid.ok) throw new LedgerError('ERR_INVALID_EVENT', valid.errors.join('; '));

    deepFreeze(event);
    this.#head = Object.freeze({ seq: event.seq, hash: event.hash });
    return event;
  }
}
