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
 *
 * Guarantee, for windowBytes of at least 16 KB: every byte a single `detectSecrets()` pass over the
 * whole file covers is covered here. The hits are identical to a single pass unless a decision
 * falls back to its line end. The fallback covers rejected decisions too, because more text can
 * flip them: a single pass judges a base64 run longer than SCAN_MAX_GROWTH windows on its full
 * length, and may call it clean. (Below 16 KB, a PEM END search can also fall back, and only the
 * first line of that block is then covered by the fallback.)
 *
 * Known limit, far past any real credential: a match is missed if it starts more than half an
 * overlap before a handover, is longer than one and a half overlaps (192 KB), and does not match at
 * all when cut short. Only a JWT segment, a URL user name, a PEM label, or blanks between a name and
 * its "=" can be that long.
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
          candidates.push({ kind: c.kind, rank: c.rank, start: start + c.start, end: lineEnd });
          next[c.rank] = Math.max(next[c.rank]!, lineEnd + 1);
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
