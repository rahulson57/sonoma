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
