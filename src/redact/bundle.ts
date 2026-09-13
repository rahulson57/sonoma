import { findSecretCandidates, mergeSecretSpans, type SecretCandidate } from './detectors.js';
import { fingerprint } from './fingerprint.js';
import { isExcludedPath } from './paths.js';
import type { RedactionHit } from './sanitize.js';

/** Scan window. Files are scanned in overlapping windows so a 1 GB file never becomes one string. */
export const SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
/** Window overlap. Every match is judged with at least half of it as context on each side. */
export const SCAN_OVERLAP_BYTES = 128 * 1024;
/** A window with a decision cut off by its end is re-scanned at double length, up to this factor. */
export const SCAN_MAX_GROWTH = 8;

const LF = 0x0a;
const CR = 0x0d;

/**
 * Where the next window starts, and so the first match start it is responsible for. The handover is
 * at the first line start in the first half of the overlap. Every detector except PEM matches within
 * one line, so a window that starts at a line start sees each line exactly as a single pass does.
 * On a longer line the handover is at the middle of the overlap instead, which leaves half an
 * overlap of context before it.
 */
function handover(buffer: Buffer, nominal: number, margin: number): { start: number; ownFrom: number } {
  const lf = buffer.subarray(nominal, nominal + margin).indexOf(LF);
  return lf === -1 ? { start: nominal, ownFrom: nominal + margin } : { start: nominal + lf + 1, ownFrom: nominal + lf + 1 };
}

/** Offset of the first CR or LF at or after `from`, or the buffer length. */
function lineBreakFrom(buffer: Buffer, from: number): number {
  const lf = buffer.indexOf(LF, from);
  const cr = buffer.indexOf(CR, from);
  if (lf === -1) return cr === -1 ? buffer.byteLength : cr;
  return cr === -1 ? lf : Math.min(lf, cr);
}

/**
 * All secret spans in `bytes`, as byte offsets. Bytes are read as latin1 (one char per byte), so
 * offsets are exact byte positions and ASCII credentials are detected wherever they sit, including
 * inside otherwise binary content.
 *
 * The result matches a single `detectSecrets()` pass over the whole file:
 * - A match belongs to the window its MATCH starts in (the NAME or scheme, not the value or
 *   password), within that window's share of the file (see `handover`). Every window judges its
 *   own matches with at least half an overlap of context before and after them.
 * - When a window's own decision reads to the window end (a match that long, or a PEM header whose
 *   END search runs past it), the window is re-scanned at double length, up to SCAN_MAX_GROWTH
 *   times. If that is still not enough, the match is treated as a secret up to the end of its line,
 *   and scanning resumes on the next line.
 *
 * Known limits, both far past any real credential: a match on a line longer than half an overlap
 * that starts right after a handover may be judged without its full line; and a PEM block that
 * begins on a line longer than SCAN_MAX_GROWTH windows is only covered by the high-entropy
 * detector past that line.
 */
export function scanBytes(
  bytes: Uint8Array,
  windowBytes: number = SCAN_WINDOW_BYTES,
  overlapBytes: number = SCAN_OVERLAP_BYTES,
): RedactionHit[] {
  if (!(overlapBytes >= 0 && windowBytes > 2 * overlapBytes)) {
    throw new RangeError('scanBytes: windowBytes must exceed twice overlapBytes');
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = buffer.byteLength;
  if (size > windowBytes && overlapBytes < 2) {
    throw new RangeError('scanBytes: overlapBytes must be at least 2 when the input spans several windows');
  }
  const step = windowBytes - overlapBytes;
  const margin = Math.floor(overlapBytes / 2);
  const candidates: SecretCandidate[] = [];

  let start = 0;
  let ownFrom = 0;
  while (start < size) {
    const next = handover(buffer, start + step, margin);
    for (let length = windowBytes; ; length *= 2) {
      const end = Math.min(size, start + length);
      const atEof = end === size;
      const ownTo = atEof ? size : next.ownFrom;
      const windowStart = start;
      const owns = (anchor: number) => windowStart + anchor >= ownFrom && windowStart + anchor < ownTo;

      const { found, cut } = findSecretCandidates(buffer.toString('latin1', start, end));
      const cutOwn = atEof ? [] : cut.filter((c) => owns(c.anchor));
      if (cutOwn.length > 0 && length < windowBytes * SCAN_MAX_GROWTH) continue;

      for (const c of found) {
        if (owns(c.anchor)) candidates.push({ ...c, anchor: start + c.anchor, start: start + c.start, end: start + c.end });
      }
      if (atEof) {
        start = size;
      } else if (cutOwn.length > 0) {
        const lineEnd = lineBreakFrom(buffer, end);
        for (const c of cutOwn) {
          candidates.push({ kind: c.kind, rank: c.rank, anchor: start + c.anchor, start: start + c.start, end: lineEnd });
        }
        start = lineEnd + 1;
        ownFrom = start;
      } else {
        start = next.start;
        ownFrom = next.ownFrom;
      }
      break;
    }
  }

  return mergeSecretSpans(candidates).map(({ kind, start: offset, end }) => ({
    kind,
    offset,
    length: end - offset,
    fingerprint: fingerprint(buffer.subarray(offset, end)),
  }));
}

/**
 * Export-time scan of every file in a bundle (SPEC-003 "Export", stage one: nothing is written
 * here). Returns every hit and the number of files scanned.
 *
 * Hits keep file order; `offset` is a byte offset within its own file. A file whose path
 * `isExcludedPath()` rejects is itself reported as an `excluded_path` hit spanning the whole file,
 * because such a file must never be in a bundle at all. To attribute hits to files, scan one file
 * per call.
 */
export async function scanBundle(
  files: AsyncIterable<{ path: string; bytes: Uint8Array }>,
): Promise<{ hits: RedactionHit[]; filesScanned: number }> {
  const hits: RedactionHit[] = [];
  let filesScanned = 0;
  for await (const file of files) {
    filesScanned++;
    if (isExcludedPath(file.path)) {
      hits.push({ kind: 'excluded_path', offset: 0, length: file.bytes.byteLength, fingerprint: fingerprint(file.bytes) });
    }
    for (const hit of scanBytes(file.bytes)) hits.push(hit);
  }
  return { hits, filesScanned };
}
