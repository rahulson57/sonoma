import { detectSecrets } from './detectors.js';
import { fingerprint } from './fingerprint.js';
import { isExcludedPath } from './paths.js';
import type { RedactionHit } from './sanitize.js';

/** Scan window. Files are scanned in overlapping windows so a 1 GB file never becomes one string. */
export const SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
/** Window overlap: longer than any bounded detector match (PEM blocks are searched up to 64 KB). */
export const SCAN_OVERLAP_BYTES = 128 * 1024;

/**
 * All secret spans in `bytes`, as byte offsets. Bytes are read as latin1 (one char per byte), so
 * offsets are exact byte positions and ASCII credentials are detected wherever they sit, including
 * inside otherwise binary content.
 *
 * A span is owned by the window it STARTS in, outside that window's trailing overlap (the next
 * window re-finds it whole). A span that runs past its window's end is joined with its continuation
 * from the next window.
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
  const step = windowBytes - overlapBytes;
  const ranges: Array<{ kind: string; start: number; end: number }> = [];

  for (let windowStart = 0; windowStart < buffer.byteLength; windowStart += step) {
    const windowEnd = Math.min(buffer.byteLength, windowStart + windowBytes);
    const isLastWindow = windowEnd === buffer.byteLength;
    for (const span of detectSecrets(buffer.toString('latin1', windowStart, windowEnd))) {
      if (!isLastWindow && span.start >= step) continue;
      const start = windowStart + span.start;
      const end = windowStart + span.end;
      const previous = ranges[ranges.length - 1];
      if (previous && start < previous.end) {
        if (end > previous.end) previous.end = end;
      } else {
        ranges.push({ kind: span.kind, start, end });
      }
    }
    if (isLastWindow) break;
  }

  return ranges.map(({ kind, start, end }) => ({
    kind,
    offset: start,
    length: end - start,
    fingerprint: fingerprint(buffer.subarray(start, end)),
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
