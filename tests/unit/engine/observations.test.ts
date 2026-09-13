/**
 * SPEC-003 at the engine's ingestion boundary: observation payloads are sanitized before storage sees them,
 * env captures are classified field by field, and SPEC-002's tool-output limit is applied.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
import { MAX_TOOL_OUTPUT_BYTES, isEngineError, sanitizePayload } from '../../../src/engine/index.js';
import { derivePendingIntent } from '../../../src/ledger/pending-intent.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import { allEvents, bytesUnder, engineFixture } from '../../integration/engine/support.js';

describe('observation sanitization', () => {
  it('redacts secretCorpus() values in tool requests, stdout and stderr, nested values and keys', () => {
    for (const { kind, value } of secretCorpus()) {
      const out = sanitizePayload('tool.completed', {
        tool_call_id: 'call_1',
        input: { command: `curl -H "Authorization: Bearer ${value}" https://api.example.invalid` },
        stdout: `response:\n${value}\n`,
        stderr: `warning: leaked ${value}`,
        nested: [{ note: value }],
        [value]: 'as a key',
      });
      const text = JSON.stringify(out);
      expect(text.includes(value), `${kind} survived sanitization`).toBe(false);
      expect(text).toContain('[REDACTED:');
      expect(out['tool_call_id']).toBe('call_1');
    }
  });

  it('classifies an env capture field by field', () => {
    const aws = secretCorpus().find((entry) => entry.kind === 'aws')?.value ?? '';
    const out = sanitizePayload('agent.started', { env: { PATH: '/usr/bin:/bin', HOME: '/home/dev', AWS_SECRET_ACCESS_KEY: aws } });
    const env = out['env'] as Array<{ name: string; classification: string; value: string | null; fingerprint: string }>;
    expect(env.map((entry) => entry.name)).toEqual(['AWS_SECRET_ACCESS_KEY', 'HOME', 'PATH']);
    expect(env[0]).toMatchObject({ classification: 'secret', value: null });
    expect(env[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(env.find((entry) => entry.name === 'PATH')?.value).toBe('/usr/bin:/bin');
    expect(JSON.stringify(out).includes(aws)).toBe(false);
  });

  it('truncates tool output over 50 MB and records truncated: true and the original length', () => {
    const line = 'build step ok\n';
    const stdout = line.repeat(Math.ceil((MAX_TOOL_OUTPUT_BYTES + 1024) / line.length));
    const out = sanitizePayload('tool.completed', { tool_call_id: 'call_big', stdout, exit_code: 0 });
    expect(Buffer.byteLength(out['stdout'] as string, 'utf8')).toBe(MAX_TOOL_OUTPUT_BYTES);
    expect(out['truncated']).toBe(true);
    expect(out['original_bytes']).toEqual({ '/stdout': Buffer.byteLength(stdout, 'utf8') });
    expect(out['exit_code']).toBe(0);
    // Small payloads are never marked.
    expect(sanitizePayload('tool.completed', { stdout: 'ok' })).toEqual({ stdout: 'ok' });
  });

  it('keeps request/acknowledgement correlation when a correlation id looks like a secret', () => {
    const suspicious = secretCorpus().find((entry) => entry.kind === 'high_entropy')?.value ?? '';
    const requested = sanitizePayload('tool.requested', { tool_call_id: suspicious, tool: 'Bash' });
    const completed = sanitizePayload('tool.completed', { tool_call_id: suspicious, stdout: '' });
    expect(requested['tool_call_id']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(completed['tool_call_id']).toBe(requested['tool_call_id']);
    const other = sanitizePayload('tool.requested', { tool_call_id: `${suspicious.slice(1)}Z`, tool: 'Bash' });
    expect(other['tool_call_id']).not.toBe(requested['tool_call_id']);
  });

  it('refuses a payload that is not a JSON object', () => {
    for (const payload of [null, 'text', [1, 2], 42]) {
      expect(() => sanitizePayload('tool.completed', payload)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_INPUT' }));
    }
  });

  it('record() persists no raw corpus bytes anywhere in the store and still resolves intents', async () => {
    const corpus = secretCorpus();
    const fx = await engineFixture({ files: { 'a.txt': 'a\n' } });
    try {
      const run = await fx.engine.startRun({ agent: 'claude-code' });
      const sealed = await fx.engine.record([
        { run_id: run.run_id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_1', tool: 'Bash', input: { command: `export T=${corpus[2]?.value}` } } },
        {
          run_id: run.run_id,
          type: 'tool.completed',
          actor: 'runtime',
          payload: { tool_call_id: 'call_1', stdout: corpus.map((entry) => entry.value).join('\n'), stderr: corpus[0]?.value },
        },
      ]);
      expect(derivePendingIntent(sealed).map((intent) => intent.status)).toEqual(['completed']);
      await fx.engine.checkpoint(run.run_id);
      await expect(fx.engine.record([{ run_id: run.run_id, type: 'tool.completed', actor: 'runtime', payload: [] as never }])).rejects.toSatisfy(
        (err: unknown) => isEngineError(err, 'ERR_INVALID_INPUT'),
      );

      const stored = await bytesUnder(path.join(fx.repo.dir, '.ckpt'));
      for (const { kind, value } of corpus) {
        expect(stored.includes(Buffer.from(value, 'utf8')), `a ${kind} corpus value is in .ckpt/`).toBe(false);
      }
      expect((await allEvents(fx.backend, run.run_id)).map((event) => event.type)).toEqual(['run.created', 'tool.requested', 'tool.completed', 'checkpoint.created']);
    } finally {
      await fx.cleanup();
    }
  });
});
