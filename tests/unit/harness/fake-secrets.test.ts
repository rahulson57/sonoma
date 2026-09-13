import { describe, expect, it } from 'vitest';
import { SECRET_KINDS, secretCorpus } from '../../helpers/fakeSecrets.js';

/** Shape checks per kind — each sample must look like the credential format it stands for. */
const SHAPES: Record<(typeof SECRET_KINDS)[number], RegExp[]> = {
  aws: [/^AKIA[A-Z2-7]{16}$/, /^[A-Za-z0-9+/]{40}$/],
  github: [/^ghp_[A-Za-z0-9]{36}$/, /^github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}$/],
  slack: [/^xoxb-\d+-\d+-[A-Za-z0-9]+$/],
  jwt: [/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/],
  pem: [/^-----BEGIN (RSA )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END (RSA )?PRIVATE KEY-----$/],
  db_url: [/^[a-z]+:\/\/[^:/@]+:[^@]{8,}@[^/]+\/\w+$/],
  high_entropy: [/^[A-Za-z0-9+/]{32,}$/],
};

function shannonEntropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

describe('secretCorpus', () => {
  it('returns at least one value for each of the 7 kinds', () => {
    const corpus = secretCorpus();
    expect([...SECRET_KINDS].sort()).toEqual(['aws', 'db_url', 'github', 'high_entropy', 'jwt', 'pem', 'slack']);
    for (const kind of SECRET_KINDS) {
      const values = corpus.filter((s) => s.kind === kind).map((s) => s.value);
      expect(values.length, `kind ${kind}`).toBeGreaterThanOrEqual(1);
      for (const value of values) expect(value.length, `kind ${kind}`).toBeGreaterThan(0);
    }
  });

  it('only contains the 7 known kinds', () => {
    for (const sample of secretCorpus()) expect(SECRET_KINDS).toContain(sample.kind);
  });

  it('every value matches the credential format of its kind', () => {
    for (const { kind, value } of secretCorpus()) {
      const matched = SHAPES[kind].some((re) => re.test(value));
      expect(matched, `${kind} sample does not match its format`).toBe(true);
    }
  });

  it('high_entropy samples are actually high-entropy', () => {
    for (const { value } of secretCorpus().filter((s) => s.kind === 'high_entropy')) {
      expect(shannonEntropyBitsPerChar(value)).toBeGreaterThan(3.5);
    }
  });

  it('is deterministic, with unique values, and returns a fresh copy each call', () => {
    const first = secretCorpus();
    expect(secretCorpus()).toEqual(first);
    expect(new Set(first.map((s) => s.value)).size).toBe(first.length);

    first[0]!.value = 'mutated';
    first.pop();
    expect(secretCorpus()[0]!.value).not.toBe('mutated');
    expect(secretCorpus().length).toBe(first.length + 1);
  });
});
