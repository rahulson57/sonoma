import { describe, expect, it } from 'vitest';
import { secretCorpus, type SecretKind } from '../../helpers/fakeSecrets.js';
import { ALPHABET, randomChars, seededRng } from '../../helpers/prng.js';
import { sanitize } from '../../../src/redact/index.js';
import { expectNoLeak, FINGERPRINT_FORMAT, sha256Fingerprint } from './leak.js';

/** Hit kinds acceptable for each corpus kind. A bare AWS secret access key has no format, only entropy. */
const EXPECTED_KINDS: Record<SecretKind, string[]> = {
  aws: ['aws', 'high_entropy'],
  github: ['github'],
  slack: ['slack'],
  jwt: ['jwt'],
  pem: ['pem'],
  db_url: ['db_url'],
  high_entropy: ['high_entropy'],
};

describe('sanitize — secretCorpus()', () => {
  it('detects and redacts 100% of the corpus entries', () => {
    const corpus = secretCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(7);
    for (const [index, { kind, value }] of corpus.entries()) {
      const input = `tool said: ${value} (end)`;
      const { output, hits } = sanitize(input);

      expectNoLeak(output, value, `corpus #${index} (${kind})`);
      expect(hits.length, `corpus #${index} (${kind}) produced no hit`).toBeGreaterThan(0);
      expect(
        hits.some((hit) => EXPECTED_KINDS[kind].includes(hit.kind)),
        `corpus #${index} (${kind}) reported as ${hits.map((h) => h.kind).join(',')}`,
      ).toBe(true);
      expect(output.startsWith('tool said: ')).toBe(true);
      expect(output.endsWith(' (end)')).toBe(true);
    }
  });

  it('redacts every corpus entry when they all share one buffer', () => {
    const corpus = secretCorpus();
    const input = corpus.map(({ value }, i) => `[${i}] 2026-09-13 INFO value=${value} ok`).join('\n');
    const { output, hits } = sanitize(input);
    for (const [index, { kind, value }] of corpus.entries()) expectNoLeak(output, value, `corpus #${index} (${kind})`);
    expect(hits.length).toBeGreaterThanOrEqual(corpus.length);
  });

  it('gives the same result for bytes as for the equivalent string', () => {
    const input = secretCorpus()
      .map(({ value }) => `stdout: ${value}`)
      .join('\n');
    expect(sanitize(new TextEncoder().encode(input))).toEqual(sanitize(input));
  });

  it('reports hits whose offset/length locate the secret in the input and whose fingerprint is its sha256', () => {
    const input = secretCorpus()
      .map(({ value }) => `-> ${value} <-`)
      .join('\n');
    const { hits } = sanitize(input);
    let previousEnd = 0;
    for (const hit of hits) {
      expect(hit.fingerprint).toMatch(FINGERPRINT_FORMAT);
      expect(hit.length).toBeGreaterThan(0);
      expect(hit.offset).toBeGreaterThanOrEqual(previousEnd); // sorted, non-overlapping
      expect(hit.fingerprint).toBe(sha256Fingerprint(input.slice(hit.offset, hit.offset + hit.length)));
      previousEnd = hit.offset + hit.length;
    }
  });

  it('replaces each secret with a [REDACTED:<kind>] marker and leaves the rest of the text intact', () => {
    const github = secretCorpus().find((s) => s.kind === 'github')!.value;
    const { output, hits } = sanitize(`clone failed for ${github}; retrying`);
    expect(output).toBe('clone failed for [REDACTED:github]; retrying');
    expect(hits).toHaveLength(1);
  });

  it('returns clean text unchanged with no hits', () => {
    const clean = 'Compiled 42 files in 1.3s\nsrc/redact/index.ts: OK\nAll tests passed.';
    expect(sanitize(clean)).toEqual({ output: clean, hits: [] });
  });

  it('is idempotent: sanitized output contains nothing left to redact', () => {
    const input = secretCorpus()
      .map(({ value }) => `API_TOKEN=${value}`)
      .join('\n');
    const once = sanitize(input).output;
    expect(sanitize(once)).toEqual({ output: once, hits: [] });
  });
});

describe('sanitize — detection beyond the fixed corpus', () => {
  it.each([
    ['base64', ALPHABET.base64, 40],
    ['alphanumeric', ALPHABET.alnum, 40],
    ['hex', ALPHABET.hex, 32],
    ['hex', ALPHABET.hex, 64],
  ])('redacts 2000 of 2000 seeded random %s tokens of length %i', (_name, alphabet, length) => {
    const rng = seededRng(0x2ed4c7 + length);
    for (let i = 0; i < 2000; i++) {
      const token = randomChars(rng, alphabet, length);
      const { output } = sanitize(`key ${token} end`);
      expect(output.includes(token), `token #${i} survived`).toBe(false);
    }
  });

  it('redacts the value of a secret-named assignment even when the value itself is low-entropy', () => {
    const weak = ['not', 'a', 'real', 'pw'].join('-');
    for (const line of [
      `AWS_SECRET_ACCESS_KEY=${weak}`,
      `export DB_PASSWORD='${weak} with spaces'`,
      `{"client_secret": "${weak}"}`,
      `spring.datasource.password: ${weak}`,
      `OPTS=--password=${weak}`,
    ]) {
      const { output, hits } = sanitize(line);
      expect(output.includes(weak), line.split(/[=:]/)[0]).toBe(false);
      expect(hits.map((h) => h.kind)).toContain('env_assignment');
    }
  });

  it('redacts the WHOLE value of a secret-named assignment: punctuation, spaces and escaped quotes included', () => {
    const pw = ['hunter', '2', 'hunter', '2'].join(''); // low-entropy fake: only the name marks it
    const punctuated = ['Xy7', '(k9;Lm2', ',pQ>'].join('');
    const marker = '[REDACTED:env_assignment]';
    const cases: Array<[input: string, expected: string]> = [
      [`DB_PASSWORD=${punctuated}`, `DB_PASSWORD=${marker}`],
      [`export API_TOKEN=${pw};rest-of-token`, `export API_TOKEN=${marker}`],
      [`{"password": "ab\\"${pw}"}`, `{"password": "${marker}"}`],
      ['DB_PASSWORD=correct horse battery staple', `DB_PASSWORD=${marker}`],
      [`password: '${pw}\\'s rest'`, `password: '${marker}'`],
      // A JSON config inside a JSON tool request: the key and value are JSON-escaped.
      [
        JSON.stringify({ content: JSON.stringify({ api_key: `ab"${pw}`, user: 'bob' }) }),
        JSON.stringify({ content: JSON.stringify({ api_key: marker, user: 'bob' }) }),
      ],
      // A bare JSON literal is the whole value; the rest of the object stays readable.
      [`{"db_password": 123456, "user": "bob"}`, `{"db_password": ${marker}, "user": "bob"}`],
    ];
    for (const [index, [input, expected]] of cases.entries()) {
      expect(sanitize(input).output, `case #${index}`).toBe(expected);
    }
  });

  it('is idempotent when a redaction marker is followed by punctuation', () => {
    const pw = ['hunter', '2', 'hunter', '2'].join('');
    const pem = secretCorpus().find((s) => s.kind === 'pem')!.value;
    for (const [index, input] of [
      `API_TOKEN="${pw}";echo ok`,
      `{"client_secret": "${pw}", "retries": 3}`,
      `export API_TOKEN=${pw};rest-of-token`,
      `PRIVATE_KEY=${pem};tail`,
      `OPTS=--password=${pw} --verbose`,
    ].entries()) {
      const once = sanitize(input);
      expect(once.hits.length, `case #${index}`).toBeGreaterThan(0);
      expect(sanitize(once.output), `case #${index}`).toEqual({ output: once.output, hits: [] });
    }
    const alreadyRedacted = 'API_TOKEN=[REDACTED:env_assignment];x';
    expect(sanitize(alreadyRedacted)).toEqual({ output: alreadyRedacted, hits: [] });
  });

  it('redacts a credentialed URL password that itself contains "@"', () => {
    const pw = ['pa', 'ss', 'word'].join('@'); // low-entropy fake
    const prefix = ['mysql', '://', 'root', ':'].join('');
    const { output } = sanitize(`connecting to ${prefix}${pw}@127.0.0.1:3306/app now`);
    expect(output).toBe(`connecting to ${prefix}[REDACTED:db_url]@127.0.0.1:3306/app now`);
  });

  it('scans a run of PEM BEGIN lines that have no END line in linear time', () => {
    const header = `${['-----BEGIN ', 'PRIVATE', ' KEY-----'].join('')}\n`;
    const text = header.repeat(Math.floor((2 * 1024 * 1024) / header.length)); // 2 MB
    const started = performance.now();
    const { output } = sanitize(text);
    // Quadratic (a 64 KB END search per header) took ~30 s here; linear takes well under a second.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(output).not.toContain('PRIVATE KEY');
  }, 30_000);

  it('scans a long line of URLs without credentials in linear time', () => {
    const text = ['http', '://', 'host', ':8080/x,'].join('').repeat(Math.floor((1024 * 1024) / 19)); // 1 MB, one line
    const started = performance.now();
    expect(sanitize(text).hits).toEqual([]);
    // Quadratic (each URL searched for "@" to the end of the line) took ~60 s here.
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 60_000);

  it('does not throw on a multi-megabyte token or quoted secret value on one line', () => {
    // V8 throws RangeError on a `{n,}` or alternation loop over a run of a few megabytes.
    const run = randomChars(seededRng(0x9b10b), ALPHABET.base64, 9 * 1024 * 1024);
    expect(sanitize(`blob ${run} end`).output).toBe('blob [REDACTED:high_entropy] end');
    const escaped = ['ab', '\\"'].join('').repeat(3 * 1024 * 1024);
    expect(sanitize(`API_TOKEN="${escaped}" ok`).output).toBe('API_TOKEN="[REDACTED:env_assignment]" ok');
  }, 60_000);

  it('keeps a non-secret assignment readable', () => {
    expect(sanitize('NODE_ENV=production LOG_LEVEL=debug').hits).toEqual([]);
  });

  it('redacts only the password of a credentialed URL, keeping host and database readable', () => {
    const url = secretCorpus().find((s) => s.kind === 'db_url')!.value;
    const { output } = sanitize(`connecting to ${url}`);
    expectNoLeak(output, url, 'db_url');
    expect(output).toContain('[REDACTED:db_url]@');
    expect(output).toContain(url.slice(url.lastIndexOf('@') + 1));
  });

  it('redacts a truncated PEM block that has no END line', () => {
    const pem = secretCorpus().find((s) => s.kind === 'pem')!.value;
    const truncated = pem.split('\n').slice(0, 6).join('\n');
    const { output } = sanitize(`${truncated}\n[output truncated]`);
    expectNoLeak(output, truncated, 'truncated pem');
    expect(output).toContain('[output truncated]');
  });
});
