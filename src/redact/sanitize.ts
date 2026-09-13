import { detectSecrets, redactionMarker } from './detectors.js';
import { fingerprint } from './fingerprint.js';

/**
 * One redacted secret (SPEC-003 public contract).
 * - `kind`: detector that found it: pem | aws | github | slack | jwt | db_url | env_assignment |
 *   high_entropy (and excluded_path from `scanBundle`).
 * - `offset` / `length`: position in the scanned INPUT. For `sanitize()` that is UTF-16 code units
 *   of the input text (a `Uint8Array` is decoded as UTF-8 first); for `scanBundle()` it is bytes
 *   within the file.
 * - `fingerprint`: `sha256:<hex>` of the secret, never the secret itself.
 */
export interface RedactionHit {
  kind: string;
  offset: number;
  length: number;
  fingerprint: string;
}

/** V8's maximum string length: the decoded text and the sanitized output must fit in one string. */
const MAX_STRING_LENGTH = 2 ** 29 - 24;

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Detect and redact secrets in a tool request, stdout, stderr or any other text capture, BEFORE it
 * is hashed or persisted (SPEC-003 invariant). Every detected span is replaced by
 * `[REDACTED:<kind>]`; overlapping detections are merged into one span, so no part of any detection
 * survives.
 *
 * Bytes are decoded as UTF-8 (invalid sequences become U+FFFD), so this is for text. Detection is
 * best-effort: false positives are expected and accepted, and a clean result is not a guarantee.
 */
export function sanitize(input: Uint8Array | string): { output: string; hits: RedactionHit[] } {
  if (typeof input !== 'string' && input.byteLength > MAX_STRING_LENGTH) {
    throw new RangeError(
      `sanitize: input of ${input.byteLength} bytes exceeds the maximum string length (${MAX_STRING_LENGTH}); ` +
        'scan it in windows instead (see scanBundle)',
    );
  }
  const text = typeof input === 'string' ? input : utf8.decode(input);
  const spans = detectSecrets(text);
  if (spans.length === 0) return { output: text, hits: [] };

  const parts: string[] = [];
  const hits: RedactionHit[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(text.slice(cursor, span.start), redactionMarker(span.kind));
    hits.push({
      kind: span.kind,
      offset: span.start,
      length: span.end - span.start,
      fingerprint: fingerprint(text.slice(span.start, span.end)),
    });
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return { output: parts.join(''), hits };
}
