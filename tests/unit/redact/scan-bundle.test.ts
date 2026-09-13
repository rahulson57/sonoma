import { describe, expect, it } from 'vitest';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { seededRng } from '../../helpers/prng.js';
import { scanBundle } from '../../../src/redact/index.js';
import { SCAN_OVERLAP_BYTES, SCAN_WINDOW_BYTES, scanBytes } from '../../../src/redact/bundle.js';
import { FINGERPRINT_FORMAT, sha256Fingerprint } from './leak.js';

type BundleFile = { path: string; bytes: Uint8Array };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function* stream(files: BundleFile[]): AsyncGenerator<BundleFile> {
  for (const file of files) yield file;
}

/** Byte range of the part of a corpus value that must be reported (a credentialed URL's password). */
function secretRange(content: string, value: string): { start: number; end: number } {
  const at = content.indexOf(value);
  const password = /:\/\/[^:/@]*:([^@]+)@/.exec(value);
  if (password?.[1]) {
    const start = at + value.indexOf(`:${password[1]}@`) + 1;
    return { start, end: start + password[1].length };
  }
  return { start: at, end: at + value.length };
}

describe('scanBundle', () => {
  it('reports every corpus hit, with filesScanned equal to the input file count', async () => {
    const corpus = secretCorpus();
    const secretFiles = corpus.map(({ value }, i) => ({
      path: `ledger/tool-output-${i}.log`,
      content: `2026-09-13T10:00:00Z tool.completed stdout=${value}\n`,
    }));
    const cleanFiles = [
      { path: 'manifest.json', content: '{"version":1,"runs":["run-1"]}' },
      { path: 'objects/readme.txt', content: 'nothing to see here\n' },
    ];
    const files: BundleFile[] = [...secretFiles, ...cleanFiles].map((f) => ({ path: f.path, bytes: encode(f.content) }));

    const report = await scanBundle(stream(files));
    expect(report.filesScanned).toBe(files.length);

    // Attribute hits per file (scanning one file per call), then check the aggregate agrees.
    let perFileTotal = 0;
    for (const [index, file] of secretFiles.entries()) {
      const { hits, filesScanned } = await scanBundle(stream([files[index]!]));
      expect(filesScanned).toBe(1);
      const range = secretRange(file.content, corpus[index]!.value);
      const covering = hits.find((h) => h.offset <= range.start && h.offset + h.length >= range.end);
      expect(covering, `corpus #${index} (${corpus[index]!.kind}) not reported`).toBeDefined();
      const bytes = files[index]!.bytes;
      expect(covering!.fingerprint).toBe(sha256Fingerprint(bytes.subarray(covering!.offset, covering!.offset + covering!.length)));
      perFileTotal += hits.length;
    }
    expect(report.hits).toHaveLength(perFileTotal);
    for (const hit of report.hits) expect(hit.fingerprint).toMatch(FINGERPRINT_FORMAT);
  });

  it('counts files with no hits and handles an empty bundle', async () => {
    expect(await scanBundle(stream([]))).toEqual({ hits: [], filesScanned: 0 });
    const clean = await scanBundle(stream([{ path: 'a.txt', bytes: encode('hello') }, { path: 'b.bin', bytes: new Uint8Array(0) }]));
    expect(clean).toEqual({ hits: [], filesScanned: 2 });
  });

  it('reports a file at a hard-excluded secret path even when its content is clean', async () => {
    const bytes = encode('LOG_LEVEL=debug\n');
    const { hits, filesScanned } = await scanBundle(stream([{ path: 'workspace/.env', bytes }]));
    expect(filesScanned).toBe(1);
    expect(hits).toEqual([{ kind: 'excluded_path', offset: 0, length: bytes.byteLength, fingerprint: sha256Fingerprint(bytes) }]);
  });

  it('finds a secret embedded in binary data at its exact byte offset', async () => {
    const secret = secretCorpus().find((s) => s.kind === 'github')!.value;
    const rng = seededRng(0xb1a);
    const noise = (n: number) => Uint8Array.from({ length: n }, () => 0x80 + Math.floor(rng() * 0x80));
    const bytes = Buffer.concat([noise(1000), Buffer.from(secret, 'latin1'), noise(1000)]);
    const { hits } = await scanBundle(stream([{ path: 'objects/blob.bin', bytes }]));
    expect(hits).toEqual([{ kind: 'github', offset: 1000, length: secret.length, fingerprint: sha256Fingerprint(secret) }]);
  });

  it('finds secrets straddling the scan-window boundaries of a large file', async () => {
    const aws = secretCorpus().find((s) => s.kind === 'aws')!.value;
    const github = secretCorpus().find((s) => s.kind === 'github')!.value;
    const step = SCAN_WINDOW_BYTES - SCAN_OVERLAP_BYTES;
    const size = SCAN_WINDOW_BYTES + step; // three windows
    const bytes = Buffer.alloc(size, 'lorem ipsum dolor sit amet ');
    const placements = [
      { value: aws, offset: step - 7 }, // crosses the first window's ownership boundary
      { value: github, offset: SCAN_WINDOW_BYTES - 11 }, // crosses the first window's end
    ];
    for (const { value, offset } of placements) {
      bytes.fill(' ', offset - 1, offset + value.length + 1);
      bytes.write(value, offset, 'latin1');
    }
    const { hits } = await scanBundle(stream([{ path: 'objects/big.log', bytes }]));
    expect(hits.map(({ offset, length }) => ({ offset, length }))).toEqual(
      placements.map(({ value, offset }) => ({ offset, length: value.length })),
    );
  });

  it('windowed scanning reports exactly what a single-pass scan reports', () => {
    const corpus = secretCorpus();
    const rng = seededRng(0x5ca7);
    let text = '';
    while (text.length < 300_000) {
      text += 'status: ok, elapsed 12ms, path src/redact/index.ts\n'.repeat(1 + Math.floor(rng() * 40));
      text += `secret: ${corpus[Math.floor(rng() * corpus.length)]!.value}\n`;
    }
    const bytes = encode(text);
    const singlePass = scanBytes(bytes, 2 ** 30, 0);
    expect(singlePass.length).toBeGreaterThan(100);
    expect(scanBytes(bytes, 4096, 1024)).toEqual(singlePass);
    expect(scanBytes(bytes, 10_000, 2048)).toEqual(singlePass);
  });
});

describe('scanBytes — window handover', () => {
  // Small windows so every boundary can be swept: nominal handover at STEP, the mid-overlap
  // handover used on long lines at STEP + MARGIN, and the first window's end at WINDOW.
  const WINDOW = 2048;
  const OVERLAP = 512;
  const STEP = WINDOW - OVERLAP;
  const MARGIN = OVERLAP / 2;
  const SIZE = 3 * WINDOW;
  const BOUNDARIES = [STEP, STEP + MARGIN, WINDOW];
  const pw = ['hunter', '2', 'hunter', '2'].join(''); // low-entropy fake: detected only by its context
  const FILLERS = [
    { name: 'short lines', text: 'lorem ipsum dolor sit amet\n', separator: '\n' },
    { name: 'one long line', text: 'lorem ipsum dolor sit amet ', separator: ' ' },
  ];

  /** SIZE bytes of filler with `line` at byte `at`, separated from the filler on both sides. */
  function withLineAt(filler: (typeof FILLERS)[number], line: string, at: number): Uint8Array {
    const body = filler.text.repeat(Math.ceil(SIZE / filler.text.length)).slice(0, SIZE);
    return encode(body.slice(0, at - 1) + filler.separator + line + filler.separator + body.slice(at + line.length + 1));
  }

  /**
   * Places `line` so that each boundary falls at every `stride`-th offset of it, and returns a
   * description of every placement where the windowed scan differs from a single pass, or where the
   * single pass does not cover `secret`.
   */
  function sweep(line: string, secret: string, stride: number): string[] {
    const failures: string[] = [];
    for (const filler of FILLERS) {
      for (const boundary of BOUNDARIES) {
        for (let at = boundary - line.length - 2; at <= boundary + 2; at += stride) {
          const bytes = withLineAt(filler, line, at);
          const single = scanBytes(bytes, 2 ** 30, 0);
          const secretAt = at + line.indexOf(secret);
          const covered = single.some((h) => h.offset <= secretAt && h.offset + h.length >= secretAt + secret.length);
          if (!covered) failures.push(`${filler.name} @${at}: single pass misses the secret`);
          if (JSON.stringify(scanBytes(bytes, WINDOW, OVERLAP)) !== JSON.stringify(single)) {
            failures.push(`${filler.name} @${at} (boundary ${boundary}): windowed != single pass`);
          }
        }
      }
    }
    return failures;
  }

  it.each([
    ['NAME=value with spaces', `DB_PASSWORD=correct horse ${pw} staple`, `correct horse ${pw} staple`],
    ['export NAME=value;rest', `export SERVICE_API_TOKEN=${pw};rest-of-token`, `${pw};rest-of-token`],
    ['scheme://user:password@host', ['postgres', '://', 'app_user', ':', pw, '@', 'db.internal.invalid:5432/app'].join(''), pw],
    ['"name": "escaped \\" value"', `{"client_secret": "ab\\"${pw}"}`, `ab\\"${pw}`],
  ])('a %s secret is reported identically wherever a window boundary falls in it', (_name, line, secret) => {
    expect(sweep(line, secret, 1)).toEqual([]);
  });

  it('at the default 8 MB / 128 KB windows, assignments and URLs cut by the handover are reported', () => {
    const step = SCAN_WINDOW_BYTES - SCAN_OVERLAP_BYTES;
    const bytes = Buffer.alloc(SCAN_WINDOW_BYTES + step, 'lorem ipsum dolor sit amet\n');
    const url = ['postgres', '://', 'app_user', ':', pw, '@', 'db.internal.invalid:5432/app'].join('');
    const placements = [
      { line: `DB_PASSWORD=${pw}`, secret: pw, cut: 'DB_PASSWORD'.length }, // between NAME and "="
      { line: url, secret: pw, cut: 'postgres:'.length }, // inside "://"
      { line: `{"client_secret": "${pw}"}`, secret: pw, cut: 3 }, // inside the key
    ].map((p, i) => ({ ...p, at: step + i * 512 - p.cut }));
    for (const { line, at } of placements) {
      bytes.write(`\n${line}\n`, at - 1, 'latin1');
    }
    const windowed = scanBytes(bytes);
    for (const { line, secret, at } of placements) {
      const secretAt = at + line.indexOf(secret);
      const covered = windowed.some((h) => h.offset <= secretAt && h.offset + h.length >= secretAt + secret.length);
      expect(covered, `${line.split(/[=:]/)[0]} not reported`).toBe(true);
    }
    expect(windowed).toEqual(scanBytes(bytes, 2 ** 30, 0));
  }, 30_000);

  it('a match longer than half the overlap is followed across the window end (window growth)', () => {
    const pem = secretCorpus().find((s) => s.kind === 'pem')!.value;
    const longValue = `${'lorem ipsum '.repeat(120)}${pw}`;
    expect(pem.length).toBeGreaterThan(MARGIN);
    expect(sweep(pem, pem, 17)).toEqual([]);
    expect(sweep(`API_TOKEN=${longValue}`, longValue, 17)).toEqual([]);
  });

  it('covers a secret-named value longer than the largest window to the end of its line', () => {
    const value = `${'lorem ipsum '.repeat(2000)}${pw}`; // ~24 KB on one line; the largest window is 8 KB
    const github = secretCorpus().find((s) => s.kind === 'github')!.value;
    const text = `first line\nAPI_TOKEN=${value}\n${'x '.repeat(3000)}${github}\n`;
    const bytes = encode(text);
    const hits = scanBytes(bytes, 1024, 256);
    const valueStart = text.indexOf(value);
    expect(hits.some((h) => h.offset <= valueStart && h.offset + h.length >= valueStart + value.length)).toBe(true);
    expect(hits.some((h) => h.kind === 'github' && h.offset === text.indexOf(github))).toBe(true);
    expect(hits).toEqual(scanBytes(bytes, 2 ** 30, 0));
  });
});
