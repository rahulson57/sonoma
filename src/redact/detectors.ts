/**
 * Secret detectors (SPEC-003 "Detection"): known credential formats, secret-named assignments and
 * high-entropy strings. Pure text in, character spans out; `sanitize()` and `scanBundle()` decide
 * what to do with the spans.
 *
 * Patterns that would read as a credential are assembled from fragments, so this file never
 * contains a credential-shaped literal (it would trip repository secret scanning).
 *
 * Unbounded repeats are written `x{n}x*`, never `x{n,}`, and never as a repeated alternation: V8
 * keeps backtracking state for every iteration of those loops and throws RangeError on a run of a
 * few megabytes (a base64 blob on one line). Quoted values and URL passwords are read with linear
 * character scans for the same reason.
 */
import { HIGH_ENTROPY_TOKEN_SOURCE, isHighEntropyToken } from './entropy.js';
import { isSecretEnvName } from './envNames.js';

/** A detected secret: `text.slice(start, end)` is the value to redact. */
export interface SecretSpan {
  kind: string;
  start: number;
  end: number;
}

/** One detector decision, before overlapping spans are merged. `rank`: detector precedence; lower wins. */
export interface SecretCandidate extends SecretSpan {
  rank: number;
}

/**
 * A decision (accepted or rejected) that looked all the way to the end of the scanned text, so it
 * could change if the text went on. `start` is the span start when accepted, else the match start.
 */
export interface CutCandidate {
  kind: string;
  rank: number;
  start: number;
  /**
   * Set only for a detector whose matches can cross line breaks (a PEM block). `end` is the span
   * end, and the scan of the detector continues there. `runsOn` is set when the match reached the
   * end of the text over a run of characters and would go on over more of them: a sticky pattern
   * of one repeated character class, so the run can be followed in pieces.
   */
  crossesLines?: { end: number; runsOn?: RegExp };
}

type Selection =
  | { start: number; end: number; resumeAt?: number; decidedEnd?: number; runsOn?: RegExp }
  | { reject: true; resumeAt: number; decidedEnd?: number };

interface Detector {
  kind: string;
  /** True when a match can run across line breaks. */
  crossesLines?: boolean;
  /** Must carry the `g` and `d` flags. */
  pattern: RegExp;
  /**
   * Resolve the secret span of a match, or reject it. `resumeAt` is where scanning continues
   * (default: the match end). `decidedEnd` is how far into the text the decision looked (default:
   * the later of the match end and `resumeAt`).
   */
  select(match: RegExpExecArray, text: string): Selection;
}

const DASHES = '-----';
const PRIVATE_KEY = ['PRIVATE', 'KEY'].join(' ');
const PEM_BEGIN = `${DASHES}BEGIN `;
/** Longest PEM body searched for a matching END line before falling back to the base64 run. */
const PEM_MAX_BODY = 65_536;
/** One character of a PEM body read without its END line: base64, line breaks, escaped newlines. */
const PEM_BODY_CHAR = '[A-Za-z0-9+/=\\r\\n\\\\]';
/** A run of PEM body characters (see CutCandidate.crossesLines). */
const PEM_BODY_RUN = new RegExp(`${PEM_BODY_CHAR}*`, 'y');

/** The whole match is the secret. */
const wholeMatch = (match: RegExpExecArray) => ({ start: match.index, end: match.index + match[0].length });

/** Alphanumeric look-around used instead of `\b`, so `MY_TOKEN_ghp...`-style glue is still caught. */
const NOT_AFTER_ALNUM = '(?<![A-Za-z0-9])';
const NOT_BEFORE_ALNUM = '(?![A-Za-z0-9])';

function execAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** True at the end of the text or of a line. */
function atLineEnd(text: string, index: number): boolean {
  return index >= text.length || text[index] === '\r' || text[index] === '\n';
}

// ---- Credentialed URL passwords ------------------------------------------------------------------

/** Password characters up to the next "@" (or the end of the run). */
const PASSWORD_RUN = /[^\s'"<>@]*/y;
const HOST_RUN = /[^\s@/?#'"<>]*/y;

/**
 * The password of a credentialed URL whose prefix (`scheme://user:`) ends at `at`. The password runs
 * to the first "@" whose host is not followed by another "@", so a raw "@" inside a password is
 * covered. When no "@" in the run qualifies, no URL starting inside the same run can have a password
 * either (it would search a suffix of the same run), so scanning resumes after the run. That keeps a
 * long line full of URLs linear.
 */
function readUrlPassword(text: string, at: number): Selection {
  if (atLineEnd(text, at) || /[\s'"<>]/.test(text[at]!)) return { reject: true, resumeAt: at };
  for (let cursor = at + 1; ; ) {
    cursor += execAt(PASSWORD_RUN, text, cursor)![0].length;
    if (text[cursor] !== '@') return { reject: true, resumeAt: cursor };
    const hostEnd = cursor + 1 + execAt(HOST_RUN, text, cursor + 1)![0].length;
    if (text[hostEnd] !== '@') return { start: at, end: cursor, resumeAt: hostEnd };
    cursor = hostEnd;
  }
}

// ---- Secret-named assignment values --------------------------------------------------------------

/**
 * A value that starts with a redaction marker was redacted by an earlier pass, but only if the value
 * ends at the marker: a delimiter or blanks to the end of the line follow it. A PEM block can end
 * mid-line, so a pem marker may also be followed by a blank. A marker that runs into more value
 * (`[REDACTED:env_assignment]hunter2`, pasted or appended text) is read as a value like any other.
 */
const MARKER_AT = /\[REDACTED:(?:pem\](?=[ \t])|[a-z_]+\](?=[ \t]*(?:[\r\n,;)}\]"'\\&|<>#]|$)))/y;
const BLANKS = /[ \t]*/y;
const DOUBLE_QUOTE_STOPS = /["\\\r\n]/g;
const SINGLE_QUOTE_STOPS = /['\\\r\n]/g;
/** A quoted value ends the value only when the quote is followed by a delimiter. */
const AFTER_QUOTED = /[\s,;:)}\]&|<>#\\]|$/y;
/** A bare JSON literal after a quoted key: `"pin": 1234,`. It cannot contain `,` `}` `]`. */
const JSON_LITERAL = /(-?\d[\d.eE+-]*|true|false|null)[ \t]*(?=[,}\]\r\n]|\\[nrt]|$)/y;
/** Any other value runs to the end of its line (trailing whitespace excluded). */
const BARE_VALUE = /\S(?:[^\r\n]*\S)?/y;
const REST_OF_LINE = /[^\r\n]*/y;

/**
 * Index just past the closing quote of the "…" or '…' value at `at` (backslash escapes honoured),
 * or -1 when it is not closed on its line.
 */
function closingQuote(text: string, at: number): number {
  const quote = text[at];
  const stops = quote === '"' ? DOUBLE_QUOTE_STOPS : SINGLE_QUOTE_STOPS;
  for (let cursor = at + 1; ; ) {
    const stop = execAt(stops, text, cursor)?.index ?? -1;
    if (stop === -1) return -1;
    if (text[stop] === quote) return stop + 1;
    if (text[stop] !== '\\' || atLineEnd(text, stop + 1)) return -1;
    cursor = stop + 2;
  }
}

/**
 * Index just past the closing \" of a JSON string inside a JSON string (a config file in a tool
 * request) whose opening \" is at `at`, or -1. Inside it, the inner string's own escapes read
 * \\\" (quote), \\\\ (backslash) and \\n; a raw " would close the enclosing string.
 */
function closingEscapedQuote(text: string, at: number): number {
  for (let cursor = at + 2; ; ) {
    const stop = execAt(DOUBLE_QUOTE_STOPS, text, cursor)?.index ?? -1;
    if (stop === -1 || text[stop] !== '\\') return -1;
    const next = text[stop + 1];
    if (next === '"') return stop + 2;
    if (next !== '\\') {
      if (atLineEnd(text, stop + 1)) return -1;
      cursor = stop + 2; // \n, \t, \/ …: one character of the inner string
    } else if (text[stop + 2] === '\\') {
      if (atLineEnd(text, stop + 3)) return -1;
      cursor = stop + 4; // \\\" or \\\\: an escaped quote or backslash of the inner string
    } else {
      if (atLineEnd(text, stop + 2) || text[stop + 2] === '"') return -1;
      cursor = stop + 3; // \\n: an escape sequence of the inner string
    }
  }
}

/**
 * The value of a secret-named assignment starting at `at`. Quoted values (including JSON-escaped
 * ones) are taken whole up to their closing quote, escapes honoured. A bare JSON literal after a
 * quoted key is taken alone. Anything else, including an unterminated quote, runs to the end of the
 * line: generated passwords contain punctuation and passphrases contain spaces, and cutting either
 * would leave the rest of the secret in the output.
 */
function readSecretValue(text: string, at: number, afterQuotedKey: boolean): Selection {
  const marker = execAt(MARKER_AT, text, at);
  if (marker) {
    // The look-ahead read the blanks after the marker and one character more.
    const end = at + marker[0].length;
    return { reject: true, resumeAt: end, decidedEnd: end + execAt(BLANKS, text, end)![0].length + 1 };
  }

  const quote = text.startsWith('\\"', at) ? 2 : text[at] === '"' || text[at] === "'" ? 1 : 0;
  if (quote > 0) {
    const end = quote === 2 ? closingEscapedQuote(text, at) : closingQuote(text, at);
    if (end !== -1 && execAt(AFTER_QUOTED, text, end)) {
      if (end - at === 2 * quote) return { reject: true, resumeAt: end }; // empty value
      return { start: at + quote, end: end - quote, resumeAt: end, decidedEnd: end + 1 };
    }
  } else if (afterQuotedKey) {
    const literal = execAt(JSON_LITERAL, text, at);
    if (literal) {
      const end = at + literal[0].length;
      return { start: at, end: at + (literal[1] ?? '').length, resumeAt: end, decidedEnd: end + 2 };
    }
  }

  const bare = execAt(BARE_VALUE, text, at);
  if (!bare) return { reject: true, resumeAt: at };
  const end = at + bare[0].length;
  const lineEnd = end + (execAt(REST_OF_LINE, text, end)?.[0].length ?? 0);
  return { start: at, end, resumeAt: lineEnd, decidedEnd: lineEnd };
}

/**
 * Ordered by precedence: when two detectors report the same span, the earlier (more specific)
 * kind is reported.
 */
const DETECTORS: readonly Detector[] = [
  {
    kind: 'pem',
    crossesLines: true,
    // A complete BEGIN…END private key block, or (truncated output) BEGIN plus the base64 run after
    // it. The END search never runs past another BEGIN line, so a run of BEGIN lines with no END
    // (grep output) is scanned once, not once per line.
    pattern: new RegExp(
      `${PEM_BEGIN}([A-Z0-9 ]*)${PRIVATE_KEY}( BLOCK)?${DASHES}` +
        `(?:((?:[^-]|-(?!${PEM_BEGIN.slice(1)})){0,${PEM_MAX_BODY}}?${DASHES}END \\1${PRIVATE_KEY}\\2${DASHES})` +
        `|${PEM_BODY_CHAR}*)`,
      'gd',
    ),
    select(match, text) {
      const end = match.index + match[0].length;
      if (match[3] !== undefined) return { start: match.index, end };
      // No END line: that decision read up to PEM_MAX_BODY characters past the header, or up to the
      // next BEGIN line. A base64 run that reaches the end of the text would go on with more text.
      const label = `${match[1] ?? ''}${PRIVATE_KEY}${match[2] ?? ''}`;
      const headerEnd = match.index + PEM_BEGIN.length + label.length + DASHES.length;
      let horizon = headerEnd + PEM_MAX_BODY + `${DASHES}END ${label}${DASHES}`.length;
      const nextBegin = text.indexOf(PEM_BEGIN, headerEnd);
      if (nextBegin !== -1) horizon = Math.min(horizon, nextBegin + PEM_BEGIN.length);
      return {
        start: match.index,
        end,
        decidedEnd: Math.max(end, horizon),
        ...(end >= text.length ? { runsOn: PEM_BODY_RUN } : {}),
      };
    },
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
      `${NOT_AFTER_ALNUM}(?:${'xo'}x[abposre]-[A-Za-z0-9-]{10,250}|${'xa'}pp-[0-9]-[A-Za-z0-9-]{10,250}|https://hooks\\.slack\\.com/services/[A-Za-z0-9/_-]{20}[A-Za-z0-9/_-]*)`,
      'gd',
    ),
    select: wholeMatch,
  },
  {
    kind: 'jwt',
    // header.payload.signature; the header is base64url JSON, so it starts `eyJ`. Signature may be empty.
    pattern: new RegExp(
      `(?<![A-Za-z0-9_-])${'ey'}J[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*`,
      'gd',
    ),
    select: wholeMatch,
  },
  {
    kind: 'db_url',
    // A URL carrying credentials: scheme, "://", optional user, ":", password, "@", host (any
    // scheme). Only the password is redacted, so the host and database stay readable. The pattern
    // finds the prefix; readUrlPassword reads the password and host.
    pattern: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/[^\s:/?#@'"<>]*:/dg,
    select: (match, text) => readUrlPassword(text, match.index + match[0].length),
  },
  {
    kind: 'env_assignment',
    // NAME=value, NAME: value, "name": "value" and JSON-escaped \"name\": \"value\", where NAME is
    // secret-named. The name is judged before the value is read (see readSecretValue), so a
    // non-secret assignment costs nothing, and scanning resumes at its value because a secret
    // assignment may be nested inside it (`OPTS=--password=...`).
    pattern: /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,100})(\\?["'])?[ \t]*([:=])[ \t]*/dg,
    select(match, text) {
      const valueStart = match.index + match[0].length;
      if (!isSecretEnvName(match[1] ?? '')) return { reject: true, resumeAt: valueStart };
      return readSecretValue(text, valueStart, match[2] !== undefined && match[3] === ':');
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

/** Number of detectors: the length of `from` and `resume` in a windowed scan. */
export const DETECTOR_COUNT = DETECTORS.length;

/** Where a scan of one window starts and stops (see `scanBytes`). */
export interface CandidateScanOptions {
  /** Per detector, in precedence order: the index its scan starts at. Default 0. */
  from?: readonly number[];
  /** Matches starting at or after this index are not decided; they are the next window's. */
  until?: number;
}

export interface CandidateScan {
  found: SecretCandidate[];
  /** Decisions that read to the end of `text`. */
  cut: CutCandidate[];
  /** Per detector, in precedence order: the index its scan continues from. */
  resume: number[];
}

/**
 * Every detector decision over `text`, unmerged, plus the decisions that read to the end of `text`
 * (`cut`). A span that is exactly a redaction marker is already-redacted content and is not
 * reported again, so sanitizing sanitized output is a no-op.
 *
 * Each detector scans independently: it decides a match, continues where that decision says, and
 * so on. `from`, `until` and `resume` let a windowed scan continue that sequence in the next window
 * instead of restarting it.
 */
export function findSecretCandidates(text: string, { from, until = Infinity }: CandidateScanOptions = {}): CandidateScan {
  const found: SecretCandidate[] = [];
  const cut: CutCandidate[] = [];
  const resume: number[] = [];
  DETECTORS.forEach((detector, rank) => {
    let cursor = from?.[rank] ?? 0;
    let match: RegExpExecArray | null;
    while ((match = execAt(detector.pattern, text, cursor)) !== null && match.index < until) {
      const matchEnd = match.index + match[0].length;
      const selected = detector.select(match, text);
      const resumeAt = Math.max(selected.resumeAt ?? matchEnd, match.index + 1);
      const accepted = 'reject' in selected ? null : selected;
      if ((selected.decidedEnd ?? Math.max(matchEnd, resumeAt)) >= text.length) {
        cut.push({
          kind: detector.kind,
          rank,
          start: accepted ? accepted.start : match.index,
          ...(detector.crossesLines
            ? { crossesLines: { end: accepted ? accepted.end : matchEnd, ...(accepted?.runsOn ? { runsOn: accepted.runsOn } : {}) } }
            : {}),
        });
      }
      if (accepted && accepted.end > accepted.start && !isRedactionMarker(text.slice(accepted.start, accepted.end))) {
        found.push({ kind: detector.kind, rank, start: accepted.start, end: accepted.end });
      }
      cursor = resumeAt;
    }
    resume.push(cursor);
  });
  return { found, cut, resume };
}

/**
 * Sorts candidates by start and merges overlapping ones into one span (so no part of an overlapping
 * detection survives redaction). A merged span keeps the kind of its earliest, longest,
 * highest-precedence member. Sorts `candidates` in place.
 */
export function mergeSecretSpans(candidates: SecretCandidate[]): SecretSpan[] {
  candidates.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  const merged: SecretSpan[] = [];
  for (const span of candidates) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ kind: span.kind, start: span.start, end: span.end });
    }
  }
  return merged;
}

/** All secret spans in `text`, sorted by start, with overlapping spans merged into one. */
export function detectSecrets(text: string): SecretSpan[] {
  return mergeSecretSpans(findSecretCandidates(text).found);
}
