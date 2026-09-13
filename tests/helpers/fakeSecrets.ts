/**
 * The shared FAKE credential corpus every redaction test uses (SPEC-001 "Secrets in tests",
 * SPEC-003 detection list).
 *
 * Every value is synthetic: generated from a fixed seed, shaped like the real credential format
 * so detectors are exercised, but never valid anywhere. Recognisable prefixes and PEM armour are
 * assembled from fragments at runtime so this source file itself never contains a
 * credential-shaped literal (it would otherwise trip repository secret scanning).
 */
import { ALPHABET, randomChars, seededRng, type Rng } from './prng.js';

export const SECRET_KINDS = ['aws', 'github', 'slack', 'jwt', 'pem', 'db_url', 'high_entropy'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretSample {
  kind: SecretKind;
  value: string;
}

/** Fixed so the corpus is identical on every call and every machine. */
const CORPUS_SEED = 0x5ec2e7;

const join = (...parts: string[]): string => parts.join('');

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function pemBlock(rng: Rng, label: string): string {
  const armour = '-----';
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) lines.push(randomChars(rng, ALPHABET.base64, 64));
  lines.push(join(randomChars(rng, ALPHABET.base64, 40), '=='));
  return [
    join(armour, 'BEGIN ', label, armour),
    ...lines,
    join(armour, 'END ', label, armour),
  ].join('\n');
}

function buildCorpus(): SecretSample[] {
  const rng = seededRng(CORPUS_SEED);
  const privateKey = ['PRIVATE', 'KEY'].join(' ');
  return [
    // AWS access key id (AKIA + 16 base32 chars) and a 40-char secret access key.
    { kind: 'aws', value: join('AK', 'IA', randomChars(rng, ALPHABET.base32, 16)) },
    { kind: 'aws', value: randomChars(rng, ALPHABET.base64, 40) },
    // GitHub classic PAT (ghp_ + 36) and fine-grained PAT (github_pat_ + 22 + _ + 59).
    { kind: 'github', value: join('gh', 'p_', randomChars(rng, ALPHABET.alnum, 36)) },
    {
      kind: 'github',
      value: join('github', '_pat_', randomChars(rng, ALPHABET.alnum, 22), '_', randomChars(rng, ALPHABET.alnum, 59)),
    },
    // Slack bot token: xoxb-<digits>-<digits>-<24 alnum>.
    {
      kind: 'slack',
      value: join('xo', 'xb-', randomChars(rng, ALPHABET.digits, 12), '-', randomChars(rng, ALPHABET.digits, 13), '-', randomChars(rng, ALPHABET.alnum, 24)),
    },
    // JWT: base64url(header).base64url(payload).base64url(signature).
    {
      kind: 'jwt',
      value: [
        base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
        base64url(JSON.stringify({ sub: `fake-user-${randomChars(rng, ALPHABET.digits, 6)}`, iat: 1700000000 })),
        Buffer.from(randomChars(rng, ALPHABET.alnum, 32), 'utf8').toString('base64url'),
      ].join('.'),
    },
    // PEM private keys (PKCS#1 RSA and PKCS#8 armour).
    { kind: 'pem', value: pemBlock(rng, join('RSA ', privateKey)) },
    { kind: 'pem', value: pemBlock(rng, privateKey) },
    // Database URLs with embedded passwords (hosts use the reserved .invalid TLD / loopback).
    {
      kind: 'db_url',
      value: join('postgres', 'ql', '://', 'app_user', ':', randomChars(rng, ALPHABET.alnum, 24), '@', 'db.internal.invalid:5432/app'),
    },
    {
      kind: 'db_url',
      value: join('mysql', '://', 'root', ':', randomChars(rng, ALPHABET.alnum, 20), '@', '127.0.0.1:3306/app'),
    },
    // Opaque high-entropy strings with no known prefix.
    { kind: 'high_entropy', value: randomChars(rng, ALPHABET.hex, 64) },
    { kind: 'high_entropy', value: randomChars(rng, ALPHABET.base64, 48) },
  ];
}

/**
 * Returns a fresh copy of the fake secret corpus: at least one sample for each of the 7 kinds
 * (aws, github, slack, jwt, pem, db_url, high_entropy). Deterministic across calls.
 */
export function secretCorpus(): Array<{ kind: SecretKind; value: string }> {
  return buildCorpus();
}
