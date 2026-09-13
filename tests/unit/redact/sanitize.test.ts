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
