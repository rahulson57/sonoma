/**
 * Identifier masking and hit application (src/bundle/scan.ts): verified identifiers are not redacted,
 * everything else Redaction flags is.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyRedactions, countEnvEntries, jsonSubject, rawSubject, scanSubject, type ExemptRule } from '../../../src/bundle/scan.js';
import { classifyEnv } from '../../../src/redact/index.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';

const hex = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const corpus = secretCorpus();
const hexSecret = corpus.find((sample) => sample.kind === 'high_entropy' && /^[0-9a-f]+$/.test(sample.value))!.value;

const topLevelHashes: ExemptRule = (p) => p.length === 1 && (p[0] === 'hash' || p[0] === 'prev_hash');

describe('jsonSubject / scanSubject', () => {
  it('does not report verified identifiers, but still reports a secret of the same shape in content', async () => {
    const document = {
      event_id: 'evt_0f8e2b1c-3d4a-4b5c-9d6e-7f8091a2b3c4',
      run_id: 'run_01J9ZQ3K4M5N6P7Q8R9S0T1V2W',
      hash: hex('a'),
      prev_hash: hex('b'),
      payload: { checkpoint: 'c_12', token: hexSecret },
    };
    const subject = jsonSubject('runs/x/events.jsonl', [{ value: document, rule: topLevelHashes }], '\n');
    expect(subject.scanned.byteLength).toBe(subject.bytes.byteLength);

    const hits = await scanSubject(subject);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(subject.bytes.toString('utf8', hit!.offset, hit!.offset + hit!.length)).toBe(hexSecret);

    const redacted = applyRedactions(subject.bytes, hits).toString('utf8');
    expect(redacted).not.toContain(hexSecret);
    expect(redacted).toContain(hex('a'));
    expect(redacted).toContain('run_01J9ZQ3K4M5N6P7Q8R9S0T1V2W');
  });

  it('reports a hash that no rule vouches for', async () => {
    const subject = jsonSubject('x.json', [{ value: { hash: hex('a') }, rule: () => false }], '');
    expect(await scanSubject(subject)).toHaveLength(1);
  });

  it('scans raw bytes unmasked and reports excluded paths', async () => {
    const hits = await scanSubject(rawSubject('.env.local', Buffer.from('NAME=value\n')));
    expect(hits.map((hit) => hit.kind)).toContain('excluded_path');
  });
});

describe('applyRedactions', () => {
  it('replaces overlapping spans with one marker and keeps the rest byte-exact', () => {
    const bytes = Buffer.from('keep SECRETSECRET keep', 'utf8');
    const out = applyRedactions(bytes, [
      { kind: 'aws', offset: 5, length: 8, fingerprint: 'x' },
      { kind: 'high_entropy', offset: 9, length: 8, fingerprint: 'y' },
    ]);
    expect(out.toString('utf8')).toBe('keep [REDACTED:aws] keep');
    expect(applyRedactions(bytes, [])).toBe(bytes);
  });
});

describe('countEnvEntries', () => {
  it('counts classifyEnv() entries anywhere in a payload', () => {
    const env = classifyEnv({ PATH: '/usr/bin', HOME: '/home/dev', API_TOKEN: 'abc' });
    expect(countEnvEntries({ context: { env }, other: [{ name: 'x' }] })).toBe(3);
  });
});
