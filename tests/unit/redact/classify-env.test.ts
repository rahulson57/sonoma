import { describe, expect, it } from 'vitest';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { classifyEnv } from '../../../src/redact/index.js';
import { expectNoLeak, FINGERPRINT_FORMAT, sha256Fingerprint } from './leak.js';

describe('classifyEnv — secret-named variables', () => {
  // Low-entropy values: the classification must come from the NAME, not from the value.
  it.each([
    ['OPENAI_API_KEY', '*_KEY'],
    ['NPM_TOKEN', '*_TOKEN'],
    ['CLIENT_SECRET', '*_SECRET'],
    ['DB_PASSWORD', '*_PASSWORD'],
    ['GOOGLE_APPLICATION_CREDENTIALS', '*CREDENTIAL*'],
    ['CREDENTIAL_HELPER', '*CREDENTIAL*'],
    ['github_token', 'lower-case *_TOKEN'],
  ])('%s (%s) → value null plus the sha256 fingerprint of the value', (name) => {
    const value = `plain-value-for-${name.length}`;
    const [entry] = classifyEnv({ [name]: value });
    expect(entry).toEqual({ name, classification: 'secret', value: null, fingerprint: sha256Fingerprint(value) });
    expect(entry!.fingerprint).toMatch(FINGERPRINT_FORMAT);
  });

  it('never carries a raw corpus secret stored under a secret name', () => {
    const env = Object.fromEntries(secretCorpus().map(({ value }, i) => [`SERVICE_${i}_TOKEN`, value]));
    const entries = classifyEnv(env);
    expect(entries.every((e) => e.classification === 'secret' && e.value === null)).toBe(true);
    const serialized = JSON.stringify(entries);
    secretCorpus().forEach(({ value }, i) => expectNoLeak(serialized, value, `corpus #${i}`));
  });
});

describe('classifyEnv — allowlisted safe variables', () => {
  const safe = {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: '/home/agent',
    NODE_ENV: 'production',
    LANG: 'en_US.UTF-8',
    CI: 'true',
  };

  it('keeps the values of PATH, HOME, NODE_ENV, LANG and CI', () => {
    const entries = classifyEnv(safe);
    expect(entries.map((e) => e.name)).toEqual(['CI', 'HOME', 'LANG', 'NODE_ENV', 'PATH']);
    for (const entry of entries) {
      const value = safe[entry.name as keyof typeof safe];
      expect(entry).toEqual({ name: entry.name, classification: 'safe', value, fingerprint: sha256Fingerprint(value) });
    }
  });

  it('still redacts a detected secret inside an allowlisted value', () => {
    const github = secretCorpus().find((s) => s.kind === 'github')!.value;
    const [entry] = classifyEnv({ PATH: `/usr/bin:/opt/${github}/bin` });
    expect(entry!.classification).toBe('safe');
    expectNoLeak(entry!.value ?? '', github, 'PATH');
    // The PATH segment carrying the token is redacted as one span (overlapping detections merge);
    // the other segments keep their values.
    expect(entry!.value).toMatch(/^\/usr\/bin:\[REDACTED:[a-z_]+\]$/);
    expect(entry!.fingerprint).toBe(sha256Fingerprint(`/usr/bin:/opt/${github}/bin`));
  });

  it('truncates a value over 64 KB and keeps the fingerprint of the full value', () => {
    const long = '/usr/bin:'.repeat(12_000); // 108 KB
    const [entry] = classifyEnv({ PATH: long });
    expect(Buffer.byteLength(entry!.value ?? '', 'utf8')).toBe(64 * 1024);
    expect(long.startsWith(entry!.value ?? '')).toBe(true);
    expect(entry!.fingerprint).toBe(sha256Fingerprint(long));
  });
});

describe('classifyEnv — other variables', () => {
  it('marks a clean, unlisted variable unknown and keeps its value', () => {
    expect(classifyEnv({ EDITOR: 'vim' })).toEqual([
      { name: 'EDITOR', classification: 'unknown', value: 'vim', fingerprint: sha256Fingerprint('vim') },
    ]);
  });

  it('classifies an innocuously named variable as secret when its value is a detected secret', () => {
    for (const [index, { kind, value }] of secretCorpus().entries()) {
      const [entry] = classifyEnv({ DATABASE_URL: value });
      expect(entry, `corpus #${index} (${kind})`).toEqual({
        name: 'DATABASE_URL',
        classification: 'secret',
        value: null,
        fingerprint: sha256Fingerprint(value),
      });
    }
  });

  it('is deterministic and independent of key insertion order', () => {
    const a = classifyEnv({ ZED: '1', API_TOKEN: 'x-1', HOME: '/h', EDITOR: 'vim' });
    const b = classifyEnv({ EDITOR: 'vim', HOME: '/h', API_TOKEN: 'x-1', ZED: '1' });
    expect(a).toEqual(b);
    expect(a.map((e) => e.name)).toEqual(['API_TOKEN', 'EDITOR', 'HOME', 'ZED']);
  });

  it('returns an empty array for an empty environment', () => {
    expect(classifyEnv({})).toEqual([]);
  });
});
