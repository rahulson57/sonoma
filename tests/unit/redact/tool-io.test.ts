import { describe, expect, it } from 'vitest';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { sanitize } from '../../../src/redact/index.js';
import { expectNoLeak } from './leak.js';

/**
 * SPEC-003 "Tool I/O": the request, stdout AND stderr of a tool call are each scanned. The Checkpoint
 * Engine sanitizes each channel as a separate capture, so each channel is asserted on its own.
 */
type Channel = 'request' | 'stdout' | 'stderr';

/** How a secret typically arrives on each channel: JSON tool input, or raw process bytes. */
const CHANNELS: Record<Channel, (secret: string) => string | Uint8Array> = {
  request: (secret) =>
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: `deploy --token ${secret}`, description: 'deploy the app' },
    }),
  stdout: (secret) => new TextEncoder().encode(`Deploying...\nusing credential ${secret}\nDone in 2.1s\n`),
  stderr: (secret) => new TextEncoder().encode(`Error: authentication failed for ${secret}\n    at deploy (deploy.js:12:7)\n`),
};

describe('sanitize — tool request, stdout and stderr', () => {
  for (const channel of Object.keys(CHANNELS) as Channel[]) {
    it(`redacts every corpus secret in the tool ${channel}`, () => {
      for (const [index, { kind, value }] of secretCorpus().entries()) {
        const { output, hits } = sanitize(CHANNELS[channel](value));
        expectNoLeak(output, value, `${channel}: corpus #${index} (${kind})`);
        expect(hits.length, `${channel}: corpus #${index} (${kind}) produced no hit`).toBeGreaterThan(0);
      }
    });
  }

  it('redacts a single tool call whose request, stdout and stderr each carry different secrets', () => {
    const corpus = secretCorpus();
    const byKind = (kind: string) => corpus.filter((s) => s.kind === kind).map((s) => s.value);
    const requestSecrets = [...byKind('github'), ...byKind('jwt')];
    const stdoutSecrets = [...byKind('aws'), ...byKind('db_url')];
    const stderrSecrets = [...byKind('pem'), ...byKind('slack'), ...byKind('high_entropy')];

    const request = sanitize(JSON.stringify({ tool_name: 'Bash', tool_input: { command: requestSecrets.join(' && ') } }));
    const stdout = sanitize(new TextEncoder().encode(stdoutSecrets.join('\n')));
    const stderr = sanitize(new TextEncoder().encode(stderrSecrets.join('\n')));

    for (const [channel, result, secrets] of [
      ['request', request, requestSecrets],
      ['stdout', stdout, stdoutSecrets],
      ['stderr', stderr, stderrSecrets],
    ] as const) {
      expect(result.hits.length, channel).toBeGreaterThanOrEqual(secrets.length);
      secrets.forEach((secret, i) => expectNoLeak(result.output, secret, `${channel} secret #${i}`));
    }
    // The sanitized request is still the JSON it was.
    expect(() => JSON.parse(request.output)).not.toThrow();
  });
});
