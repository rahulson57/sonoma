/**
 * Secret detectors (SPEC-003 "Detection"): known credential formats, secret-named assignments and
 * high-entropy strings. Pure text in, character spans out; `sanitize()` and `scanBundle()` decide
 * what to do with the spans.
 *
 * Patterns that would read as a credential are assembled from fragments, so this file never
 * contains a credential-shaped literal (it would trip repository secret scanning).
 */
import { HIGH_ENTROPY_TOKEN_SOURCE, isHighEntropyToken } from './entropy.js';
import { isSecretEnvName } from './envNames.js';

/** A detected secret: `text.slice(start, end)` is the value to redact. */
export interface SecretSpan {
  kind: string;
  start: number;
  end: number;
}

interface Detector {
  kind: string;
  /** Must carry the `g` and `d` flags. */
  pattern: RegExp;
  /** Resolve the secret span of a match, or null to reject it and resume scanning at `resumeAt`. */
  select(match: RegExpExecArray): { start: number; end: number } | { reject: true; resumeAt: number };
}

const DASHES = '-----';
const PRIVATE_KEY = ['PRIVATE', 'KEY'].join(' ');
/** Longest PEM body searched for a matching END line before falling back to the base64 run. */
const PEM_MAX_BODY = 65_536;

/** The whole match is the secret. */
const wholeMatch = (match: RegExpExecArray) => ({ start: match.index, end: match.index + match[0].length });

/** The first participating capture group among `groups` is the secret. */
function firstGroup(groups: number[]) {
  return (match: RegExpExecArray) => {
    for (const group of groups) {
      const range = match.indices?.[group];
      if (range) return { start: range[0], end: range[1] };
    }
    return wholeMatch(match);
  };
}

/** Alphanumeric look-around used instead of `\b`, so `MY_TOKEN_ghp...`-style glue is still caught. */
const NOT_AFTER_ALNUM = '(?<![A-Za-z0-9])';
const NOT_BEFORE_ALNUM = '(?![A-Za-z0-9])';

/**
 * Ordered by precedence: when two detectors report the same span, the earlier (more specific)
 * kind is reported.
 */
const DETECTORS: readonly Detector[] = [
  {
    kind: 'pem',
    // A complete BEGIN…END private key block, or (truncated output) BEGIN plus the base64 run after it.
    pattern: new RegExp(
      `${DASHES}BEGIN ([A-Z0-9 ]*)${PRIVATE_KEY}( BLOCK)?${DASHES}` +
        `(?:[\\s\\S]{0,${PEM_MAX_BODY}}?${DASHES}END \\1${PRIVATE_KEY}\\2${DASHES}|[A-Za-z0-9+/=\\r\\n\\\\]*)`,
      'gd',
    ),
    select: wholeMatch,
  },
  {
    kind: 'aws',
    // AWS access key ids: 4-letter type prefix + 16 upper-case alphanumerics.
    pattern: new RegExp(
      `${NOT_AFTER_ALNUM}(?:${['AK', 'AS', 'AB', 'AC', 'AG', 'AI', 'AN', 'AR', 'AP'].map((p) => `${p}[A-Z]{2}`).join('|')})[A-Z0-9]{16}${NOT_BEFORE_ALNUM}`,
      'gd',
    ),
    select: wholeMatch,
  },
  {
    kind: 'github',
    // Classic tokens (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained PATs.
    pattern: new RegExp(
      `${NOT_AFTER_ALNUM}(?:${'gh'}[pousr]_[A-Za-z0-9]{36,255}|${'github'}_pat_[A-Za-z0-9_]{22,255})${NOT_BEFORE_ALNUM}`,
      'gd',
    ),
    select: wholeMatch,
  },
  {
    kind: 'slack',
    // Bot/user/app tokens and incoming-webhook URLs.
    pattern: new RegExp(
      `${NOT_AFTER_ALNUM}(?:${'xo'}x[abposre]-[A-Za-z0-9-]{10,250}|${'xa'}pp-[0-9]-[A-Za-z0-9-]{10,250}|https://hooks\\.slack\\.com/services/[A-Za-z0-9/_-]{20,})`,
      'gd',
    ),
    select: wholeMatch,
  },
  {
    kind: 'jwt',
    // header.payload.signature; the header is base64url JSON, so it starts `eyJ`. Signature may be empty.
    pattern: new RegExp(`(?<![A-Za-z0-9_-])${'ey'}J[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*`, 'gd'),
    select: wholeMatch,
  },
  {
    kind: 'db_url',
    // A URL carrying credentials: scheme, "://", optional user, ":", password, "@", host (any
    // scheme). Only the password is redacted,
    // so the host and database stay readable.
    pattern: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/[^\s:/?#@'"<>]*:([^\s@'"<>]+)@/dg,
    select: firstGroup([1]),
  },
  {
    kind: 'env_assignment',
    // NAME=value, NAME: value, "name": "value" where NAME is secret-named. Quoted values are taken
    // whole (spaces included); bare values run to whitespace or punctuation.
    pattern:
      /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,100})["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`,;{}()[\]<>]+))/dg,
    select(match) {
      const valueRange = match.indices?.[2] ?? match.indices?.[3] ?? match.indices?.[4];
      const name = match[1] ?? '';
      if (!valueRange) return { reject: true, resumeAt: match.index + 1 };
      // A rejected name may still have a secret assignment nested inside its value
      // (`OPTS=--password=...`), so resume at the value instead of skipping past it.
      if (!isSecretEnvName(name)) return { reject: true, resumeAt: valueRange[0] };
      return { start: valueRange[0], end: valueRange[1] };
    },
  },
  {
    kind: 'high_entropy',
    pattern: new RegExp(`${HIGH_ENTROPY_TOKEN_SOURCE}`, 'gd'),
    select(match) {
      // Trailing base64 padding belongs to the token; anything else is judged on its own.
      if (!isHighEntropyToken(match[0])) return { reject: true, resumeAt: match.index + match[0].length };
      return wholeMatch(match);
    },
  },
];

/** Text that replaces a redacted secret in sanitized output. */
export function redactionMarker(kind: string): string {
  return `[REDACTED:${kind}]`;
}

const REDACTION_MARKER = /^\[REDACTED:[a-z_]+\]$/;

/** True when `text` is exactly a redaction marker, i.e. content that has already been redacted. */
export function isRedactionMarker(text: string): boolean {
  return REDACTION_MARKER.test(text);
}

/**
 * All secret spans in `text`, sorted by start, with overlapping spans merged into one (so no part
 * of an overlapping secret survives redaction). A merged span keeps the kind of its earliest,
 * longest, highest-precedence member.
 *
 * A span that is exactly a redaction marker is already-redacted content and is not reported
 * again, so sanitizing sanitized output is a no-op.
 */
export function detectSecrets(text: string): SecretSpan[] {
  const found: Array<SecretSpan & { rank: number }> = [];
  DETECTORS.forEach((detector, rank) => {
    const { pattern } = detector;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const selected = detector.select(match);
      if ('reject' in selected) {
        pattern.lastIndex = Math.max(selected.resumeAt, match.index + 1);
        continue;
      }
      if (selected.end > selected.start && !isRedactionMarker(text.slice(selected.start, selected.end))) {
        found.push({ kind: detector.kind, start: selected.start, end: selected.end, rank });
      }
      if (match[0].length === 0) pattern.lastIndex++;
    }
  });

  found.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  const merged: SecretSpan[] = [];
  for (const span of found) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ kind: span.kind, start: span.start, end: span.end });
    }
  }
  return merged;
}
