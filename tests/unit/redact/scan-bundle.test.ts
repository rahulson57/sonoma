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

// Several tests scan multi-megabyte buffers (seconds each). vitest's 5 s default is too tight when the
// whole suite runs in parallel on a loaded machine, so these blocks set their own timeout.
describe('scanBundle', { timeout: 30_000 }, () => {
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

describe('scanBytes — window handover', { timeout: 30_000 }, () => {
  // Small windows so every boundary can be swept: the second window's text starts at STEP - MARGIN
  // (and its scan one byte later), matches starting at STEP or later belong to it, and the first
  // window ends at WINDOW. STEP + MARGIN is where an earlier design handed over on long lines.
  const WINDOW = 2048;
  const OVERLAP = 512;
  const STEP = WINDOW - OVERLAP;
  const MARGIN = OVERLAP / 2;
  const SIZE = 3 * WINDOW;
  const BOUNDARIES = [STEP - MARGIN, STEP, STEP + MARGIN, WINDOW];
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
        for (let at = Math.max(1, boundary - line.length - 2); at <= boundary + 2; at += stride) {
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

  /** Hits that differ from a single pass, or secrets (at `secretsAt`) the single pass does not cover. */
  function compareWithSinglePass(bytes: Uint8Array, secretsAt: number[], secretLength: number, windowBytes?: number, overlapBytes?: number): string[] {
    const failures: string[] = [];
    const single = scanBytes(bytes, 2 ** 30, 0);
    for (const at of secretsAt) {
      if (!single.some((h) => h.offset <= at && h.offset + h.length >= at + secretLength)) failures.push(`single pass misses @${at}`);
    }
    if (JSON.stringify(scanBytes(bytes, windowBytes, overlapBytes)) !== JSON.stringify(single)) failures.push('windowed != single pass');
    return failures;
  }

  it.each([
    ['a word whose suffix is secret-named ("monkey=" holds "key=")', ' monkey=banana '],
    ['a word whose suffix is secret-named ("OAUTH:" holds "AUTH:")', ' OAUTH: enabled '],
    ['a quoted secret value that contains a secret-named assignment', '{"db_secret": "Server=db;Password=x;Timeout=30", "note": "nnnnnnnnnn", '],
  ])('a window boundary inside %s does not hide a later secret on the same long line', (_name, trigger) => {
    // One long line: the trigger swept across every boundary, then two secrets inside the second
    // window's share (it hands over at 2 * STEP - MARGIN), then the end of the line.
    const later = `"api_token": "${pw}"}, DB_PASSWORD=${pw}`;
    const laterAt = 2 * STEP - MARGIN - 200;
    const secretsAt = [laterAt + later.indexOf(pw), laterAt + later.lastIndexOf(pw)];
    const failures: string[] = [];
    for (const boundary of BOUNDARIES) {
      for (let at = boundary - trigger.length - 2; at <= boundary + 2; at++) {
        const bytes = Buffer.alloc(SIZE, 'lorem ipsum dolor sit amet ');
        bytes.write(trigger, at, 'latin1');
        bytes.write(later, laterAt, 'latin1');
        bytes.write('\n', laterAt + later.length + 40, 'latin1');
        for (const failure of compareWithSinglePass(bytes, secretsAt, pw.length, WINDOW, OVERLAP)) {
          failures.push(`trigger @${at} (boundary ${boundary}): ${failure}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('at the default 8 MB / 128 KB windows, a boundary inside a word or a quoted secret value does not hide a later secret', () => {
    const step = SCAN_WINDOW_BYTES - SCAN_OVERLAP_BYTES;
    const margin = SCAN_OVERLAP_BYTES / 2;
    const size = SCAN_WINDOW_BYTES + step; // two windows, handing over at `step`
    const later = `"api_token": "${pw}"}, DB_PASSWORD=${pw}`;
    const laterAt = step + margin + 3000;
    const secretsAt = [laterAt + later.indexOf(pw), laterAt + later.lastIndexOf(pw)];

    // Words whose suffix is secret-named, at the second window's first byte, at the handover, and
    // where an earlier design started the second window's ownership.
    const words = Buffer.alloc(size, 'lorem ipsum dolor sit amet ');
    words.write(' OAUTH: enabled ', step - margin - 2, 'latin1'); // "A" at step - margin
    words.write(' monkey=banana ', step - 4, 'latin1'); // "k" at step
    words.write(' OAUTH: enabled ', step + margin - 2, 'latin1');
    words.write(later, laterAt, 'latin1');
    words.write('\n', laterAt + later.length + 40, 'latin1');
    expect(compareWithSinglePass(words, secretsAt, pw.length)).toEqual([]);

    // A quoted secret value, holding many secret-named assignments, around the whole handover.
    const quoted = Buffer.alloc(size, 'lorem ipsum dolor sit amet ');
    const value = 'Server=db;Password=x;Timeout=30;'.repeat(Math.ceil((2 * margin + 2000) / 32));
    quoted.write(`{"db_secret": "${value}", `, step - margin - 1000, 'latin1');
    quoted.write(later, laterAt + 2000, 'latin1');
    quoted.write('\n', laterAt + 2000 + later.length + 40, 'latin1');
    expect(compareWithSinglePass(quoted, secretsAt.map((at) => at + 2000), pw.length)).toEqual([]);
  }, 120_000); // four full scans of a 16 MB buffer

  it('reports exactly what a single pass reports on random text of assignments, quoted values, words, URLs, tokens and PEM blocks', () => {
    // This seed and generator found 5 of 150 texts where the previous handover (restarting each
    // window's scan at its first byte) differed from a single pass.
    const rng = seededRng(0x447);
    const configs: Array<[windowBytes: number, overlapBytes: number]> = [[2048, 512], [1300, 600], [1100, 540]];
    const failures: string[] = [];
    let singlePassHits = 0;
    for (let round = 0; round < 150; round++) {
      // No line breaks, long lines or short lines. At most 8 KB, so a grown window always reaches
      // the end of the text and no decision falls back to its line end.
      const lineBreak = [0, 1 / 100, 1 / 10][Math.floor(rng() * 3)]!;
      const bytes = Buffer.from(randomRecords(rng, 3000 + Math.floor(rng() * 5000), lineBreak), 'latin1');
      const single = scanBytes(bytes, 2 ** 30, 0);
      singlePassHits += single.length;
      for (const [windowBytes, overlapBytes] of configs) {
        if (JSON.stringify(scanBytes(bytes, windowBytes, overlapBytes)) !== JSON.stringify(single)) {
          failures.push(`round ${round} (${windowBytes}/${overlapBytes})`);
          break;
        }
      }
    }
    expect(singlePassHits).toBeGreaterThan(3000);
    expect(failures).toEqual([]);
  }, 60_000);
});

function randomBase64(rng: () => number, length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return Array.from({ length }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
}

/**
 * `length` characters of records: secret-named and plain assignments with quoted, JSON-escaped,
 * literal and (rarely) bare values, words with a secret-named suffix, credentialed URLs, tokens,
 * PEM blocks and stray punctuation. All values are low-entropy fakes or seeded random tokens.
 */
function randomRecords(rng: () => number, length: number, lineBreak: number): string {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
  const int = (n: number) => Math.floor(rng() * n);
  const pw = ['hunter', '2', 'hunter', '2'].join('');
  const token = () => randomBase64(rng, 20 + int(30));
  const pemBegin = ['-----BEGIN ', 'RSA ', 'PRIVATE', ' KEY-----'].join('');
  const pemEnd = ['-----END ', 'RSA ', 'PRIVATE', ' KEY-----'].join('');
  const secretNames = ['api_token', 'DB_PASSWORD', 'client_secret', 'Password', 'db_secret', 'AUTH', 'key'];
  const plainNames = ['LOG_LEVEL', 'user', 'monkey', 'OAUTH', 'bypass', 'note', 'Server', 'Timeout'];
  const inner = () =>
    pick([
      'Server=db;Password=x;Timeout=30',
      'user=bob; key=abc',
      pw,
      `ab\\"${pw}`,
      `it\\'s ${pw}`,
      'a b c',
      `token: ${pw}`,
      'OAUTH: enabled',
      '[REDACTED:env_assignment]',
      token(),
      '',
    ]);
  const value = (): string => {
    if (rng() < 0.05) return pick([inner(), `${pw};rest`, '[REDACTED:env_assignment]', `[REDACTED:env_assignment]${pw}`]);
    return pick([`"${inner()}"`, `'${inner()}'`, `\\"${inner()}\\"`, String(int(99999)), 'true', 'null', `"${inner()}" x`]);
  };
  const record = (): string => {
    switch (int(10)) {
      case 0:
      case 1:
        return Array.from({ length: 1 + int(12) }, () => pick(['lorem', 'ipsum', 'dolor', 'sit', 'amet'])).join(' ');
      case 2:
        return `${pick([...secretNames, ...plainNames])}${pick(['=', ': ', ' = ', ':'])}${value()}`;
      case 3:
        return `"${pick([...secretNames, ...plainNames])}": ${value()}`;
      case 4:
        return `\\"${pick([...secretNames, ...plainNames])}\\": ${value()}`;
      case 5:
        return pick(['monkey=banana', 'OAUTH: enabled', 'bypass=1', 'compass: north', '{"db_secret": "Server=db;Password=x;Timeout=30", "note": "n"']);
      case 6:
        return pick([
          ['postgres', '://', 'app_user', ':', pw, '@', 'db.internal.invalid/app'].join(''),
          'https://example.invalid/x?a=1',
          ['mysql', '://', 'root', ':', pw, '@@h/x'].join(''),
          ['ey', 'Jabcdefghij.', 'ey', 'Jabcdefghij.', token()].join(''),
        ]);
      case 7:
        return pick([token(), `x${token()}`, `${token()}==`]);
      case 8:
        return pick([`${pemBegin}\n${token()}\n${token()}\n${pemEnd}`, pemBegin, `${pemBegin}\n${token()}`]);
      default:
        return Array.from({ length: 1 + int(3) }, () => pick(['"', "'", '\\', '=', ':', '[', ']', '{', '}', ',', ';', '\\n', pw, 'key', '='])).join('');
    }
  };
  let text = '';
  while (text.length < length) text += record() + (rng() < lineBreak ? pick(['\n', '\r\n']) : pick([' ', ', ', '; ', ' & ', '']));
  return text.slice(0, length);
}
