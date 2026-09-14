/**
 * Budget arithmetic and the hydrated form of a ledger event (SPEC-008 "Truncation policy"; DEC-036(3), DEC-036(4)).
 *
 * - tokenEstimate = ceil(canonicalJSON({systemPreamble, state, workspaceCommit, hydratedEvents}).length / 4).
 * - Every value the builder returns is a plain JSON copy with the members of every object in canonical order, so its
 *   JSON depends only on the values, never on how the caller built its objects (byte-identical output).
 * - An event is hydrated whole or not at all. Only a payload that already IS a CAS blob (payload_ref ≠ null: the
 *   ledger offloads payloads over its inline limit) is referenced: the event keeps its stored payload_ref with payload
 *   null, and the blob is never read. An inline payload stays inline, whatever its size. A payload_ref is never made
 *   up: LedgerEvent.payload_ref names a CAS blob, and a ref to bytes that are not in CAS would dangle for any consumer
 *   that calls getBlob.
 */
import { CanonicalJsonError, canonicalJSON } from '../ledger/canonical-json.js';
import type { AgentStateObject, LedgerEvent } from '../model/types.js';
import { ContextError } from './errors.js';
import { CHARS_PER_TOKEN } from './types.js';

export function tokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function canonical(value: unknown, what: string): string {
  try {
    return canonicalJSON(value);
  } catch (err) {
    if (err instanceof CanonicalJsonError) throw new ContextError('ERR_CORRUPT', `${what} is not plain JSON: ${err.message}`, { cause: err });
    throw err;
  }
}

/** Length of the canonical JSON of `value`. */
export function canonicalChars(value: unknown, what: string): number {
  return canonical(value, what).length;
}

/** A plain JSON copy with object members in canonical (sorted) order. */
export function normalizeJson<T>(value: T, what: string): T {
  return JSON.parse(canonical(value, what)) as T;
}

/** Characters `text` takes inside a JSON string literal: its escaped form, without the quotes. */
export function jsonTextChars(text: string): number {
  return JSON.stringify(text).length - 2;
}

/**
 * Characters these lines add to a preamble that already has at least one line, measured inside the context's JSON:
 * each escaped line plus the escaped newline (two characters) that joins it. Escaping is per character, so the sum is
 * exact wherever the lines are inserted.
 */
export function preambleLinesChars(lines: readonly string[]): number {
  let chars = 0;
  for (const line of lines) chars += jsonTextChars(line) + 2;
  return chars;
}

/** The event as it appears in `hydratedEvents`: whole; a payload already stored as a blob stays a ref (DEC-036(3)). */
export function hydrateEvent(event: LedgerEvent): LedgerEvent {
  const copy = normalizeJson(event, `ledger event seq ${String(event.seq)}`);
  // Spreading keeps the canonical member order: payload is replaced in place, payload_ref is the stored one.
  return copy.payload_ref === null ? copy : { ...copy, payload: null };
}

export interface ContextParts {
  readonly systemPreamble: string;
  readonly state: AgentStateObject;
  readonly workspaceCommit: string;
  readonly hydratedEvents: readonly LedgerEvent[];
}

/** The character count tokenEstimate is defined over (DEC-036(4)). */
export function contextChars(parts: ContextParts): number {
  const { systemPreamble, state, workspaceCommit, hydratedEvents } = parts;
  return canonicalChars({ systemPreamble, state, workspaceCommit, hydratedEvents }, 'the resume context');
}
