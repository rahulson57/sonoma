import { DETECTOR_COUNT, findSecretCandidates, mergeSecretSpans, type SecretCandidate } from './detectors.js';
import { fingerprint } from './fingerprint.js';
import { isExcludedPath } from './paths.js';
import type { RedactionHit } from './sanitize.js';

/** Scan window. Files are scanned in overlapping windows so a 1 GB file never becomes one string. */
export const SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
/**
 * Window overlap: how far a window reads past its handover. A decision that reads further than
 * that is re-decided in a larger window (see SCAN_MAX_GROWTH).
 */
export const SCAN_OVERLAP_BYTES = 128 * 1024;
/** A window with a decision cut off by its end is re-scanned at double length, up to this factor. */
export const SCAN_MAX_GROWTH = 8;

const LF = 0x0a;
const CR = 0x0d;

/** Offset of the first CR or LF at or after `from`, or the buffer length. */
function lineBreakFrom(buffer: Buffer, from: number): number {
  const lf = buffer.indexOf(LF, from);
  const cr = buffer.indexOf(CR, from);
  if (lf === -1) return cr === -1 ? buffer.byteLength : cr;
  return cr === -1 ? lf : Math.min(lf, cr);
}

/**
 * Offset of the first byte at or after `from` that is not part of the run `runsOn` matches (a sticky
 * pattern of one repeated character class), or the buffer length. Read in pieces of `pieceBytes`,
 * so a run of any length is followed without decoding it as one string.
 */
function runEndFrom(buffer: Buffer, from: number, runsOn: RegExp, pieceBytes: number): number {
  for (let at = from; at < buffer.byteLength; ) {
    const pieceEnd = Math.min(buffer.byteLength, at + pieceBytes);
    runsOn.lastIndex = 0;
    at += runsOn.exec(buffer.toString('latin1', at, pieceEnd))?.[0].length ?? 0;
    if (at < pieceEnd) return at;
  }
  return buffer.byteLength;
}

/**
 * All secret spans in `bytes`, as byte offsets. Bytes are read as latin1 (one char per byte), so
 * offsets are exact byte positions and ASCII credentials are detected wherever they sit, including
 * inside otherwise binary content.
 *
 * Windows hand over by CONTINUING each detector's scan, never restarting it:
 * - A window reads [start, start + windowBytes) and decides every match that STARTS before its
 *   handover, `overlapBytes` before its end. Later matches are left to the next window.
 * - The next window resumes each detector exactly where the previous window's scan of it stopped:
 *   past the last value or match it decided (which may reach beyond the handover), but no earlier
 *   than half an overlap before the handover. Its text starts one byte before that, so look-behinds
 *   see the same byte a single pass sees.
 * - So no window starts parsing inside a value or match that an earlier window decided, or inside
 *   a word (`monkey=` is never read as `key=`), and the windows make the decisions a single pass
 *   makes, in the same order.
 * - A decision that reads to the end of its window (a long value or token, a PEM END search)
 *   re-scans the window at double length, up to SCAN_MAX_GROWTH times. If it still reads to the
 *   end, that match is covered up to the end of its line, and its detector resumes on the next line.
 *   That fails closed.
 * - A PEM block is the only match that can cross a line break, so it does not fall back to a line
 *   end alone. When its base64 run (no END line) still reaches the end of the largest window, the
 *   run is followed through the file to its real end, in window-sized pieces: that is the span a
 *   single pass reports, and pem resumes there, as a single pass does. Any other cut PEM decision is
 *   covered to the end of the line the window ends in, and pem resumes where its match ended, so a
 *   later block that starts on that line is still decided.
 *
 * Guarantee, for windowBytes of at least 16 KB: every byte a single `detectSecrets()` pass over the
 * whole file covers is covered here, including a PEM base64 run of any length, apart from the known
 * limit below. The hits are identical to a single pass unless a decision falls back to its line
 * end. The fallback covers rejected decisions too, because more text can flip them: a single pass
 * judges a base64 token longer than SCAN_MAX_GROWTH windows on its full length, and may call it
 * clean.
 *
 * Below 16 KB the largest window can be shorter than a PEM END search (up to 64 KB of body), so the
 * END line of a block may lie past it. That block is then covered only to the end of its base64
 * run, or of the line the window ends in, which can leave out the rest of the block and its END
 * line.
 *
 * Known limit: a match is missed if it starts more than half an overlap before a handover, is longer
 * than one and a half overlaps, and does not match at all when cut short. At the default overlap
 * that is 192 KB, far past any real credential: only a JWT segment, a URL user name, a PEM label, or
 * blanks between a name and its "=" can be that long. A small overlap lowers the bound for every
 * match (at 2 bytes, a PEM header alone is too long).
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
  /** Per detector: the absolute offset its scan continues from. */
  let cursors = new Array<number>(DETECTOR_COUNT).fill(0);
  for (;;) {
    const handover = start + step;
    for (let length = windowBytes; ; length *= 2) {
      const end = Math.min(size, start + length);
      const atEof = end === size;
      const { found, cut, resume } = findSecretCandidates(buffer.toString('latin1', start, end), {
        from: cursors.map((cursor) => cursor - start),
        until: atEof ? Infinity : handover - start,
      });
      if (!atEof && cut.length > 0 && length < windowBytes * SCAN_MAX_GROWTH) continue;

      for (const c of found) candidates.push({ ...c, start: start + c.start, end: start + c.end });
      if (atEof) return toHits(buffer, candidates);

      const floor = handover - margin;
      const next = resume.map((cursor) => Math.max(start + cursor, floor));
      if (cut.length > 0) {
        const lineEnd = lineBreakFrom(buffer, end);
        for (const c of cut) {
          let spanEnd = lineEnd;
          let resumeAt = lineEnd + 1;
          if (c.crossesLines) {
            // A match that can cross line breaks resumes where it ends, not on the next line: a
            // later match of it may start on the same line and run past the line end.
            const { end: matchEnd, runsOn } = c.crossesLines;
            resumeAt = runsOn ? runEndFrom(buffer, end, runsOn, windowBytes) : start + matchEnd;
            spanEnd = runsOn ? resumeAt : Math.max(lineEnd, resumeAt);
          }
          candidates.push({ kind: c.kind, rank: c.rank, start: start + c.start, end: spanEnd });
          next[c.rank] = Math.max(next[c.rank]!, resumeAt);
        }
      }
      cursors = next;
      start = floor - 1;
      break;
    }
  }
}

function toHits(buffer: Buffer, candidates: SecretCandidate[]): RedactionHit[] {
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
