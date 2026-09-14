/**
 * SPEC-014 envelope invariant / SPEC-002 "Payload limits", end to end through the real Checkpoint Engine,
 * Redaction, ledger and LocalBackend (no stubs):
 *
 * | Item                 | Max   | Over-limit policy                                                      |
 * |----------------------|-------|------------------------------------------------------------------------|
 * | Single file          | 1 GB  | excluded, `workspace.file_skipped` ledger event                        |
 * | Tool output          | 50 MB | truncated to 50 MB, `truncated: true` + original byte length recorded  |
 * | Inline event payload | 1 MB  | stored as CAS blob, event carries a blob reference (`payload_ref`)     |
 * | Env value            | 64 KB | truncated, fingerprint of the full value kept                          |
 *
 * The over-1 GB file is a sparse file, so the test costs no real disk space; the engine never reads a file it
 * excludes by size.
 */
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
// Redacting a 50 MB tool output and spawning git are slow on a loaded gate.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });
import { MAX_SNAPSHOT_FILE_BYTES, MAX_TOOL_OUTPUT_BYTES } from '../../../src/engine/index.js';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import { MAX_ENV_VALUE_BYTES } from '../../../src/redact/env.js';
import { fingerprint } from '../../../src/redact/fingerprint.js';
import type { EnvEntry } from '../../../src/redact/index.js';
import { allEvents, engineFixture, sha256, treePaths } from '../engine/support.js';

// The SPEC-002 table itself, stated independently of the constants in src/.
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const SPEC_FILE_LIMIT = 1 * GB;
const SPEC_TOOL_OUTPUT_LIMIT = 50 * MB;
const SPEC_INLINE_PAYLOAD_LIMIT = 1 * MB;
const SPEC_ENV_VALUE_LIMIT = 64 * KB;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe('SPEC-002 payload limits', () => {
  it('the limits in force are exactly the SPEC-002 table', () => {
    expect(MAX_SNAPSHOT_FILE_BYTES).toBe(SPEC_FILE_LIMIT);
    expect(MAX_TOOL_OUTPUT_BYTES).toBe(SPEC_TOOL_OUTPUT_LIMIT);
    expect(MAX_INLINE_PAYLOAD_BYTES).toBe(SPEC_INLINE_PAYLOAD_LIMIT);
    expect(MAX_ENV_VALUE_BYTES).toBe(SPEC_ENV_VALUE_LIMIT);
  });

  it('a file over 1 GB is excluded from the checkpoint and recorded as workspace.file_skipped', async () => {
    const fx = await engineFixture({ files: { 'kept.txt': 'kept\n' } });
    try {
      const hugePath = path.join(fx.repo.dir, 'huge.bin');
      const handle = await open(hugePath, 'w');
      try {
        await handle.truncate(SPEC_FILE_LIMIT + 1); // sparse: no data blocks are written
      } finally {
        await handle.close();
      }
      expect((await stat(hugePath)).size).toBe(SPEC_FILE_LIMIT + 1);

      const run = await fx.engine.startRun({ agent: 'envelope-payload-limits' });
      const checkpoint = await fx.engine.checkpoint(run.run_id);

      const tree = await treePaths(fx.repo.dir, checkpoint.workspace_commit);
      expect(tree).toContain('kept.txt');
      expect(tree).not.toContain('huge.bin');

      const events = await allEvents(fx.backend, run.run_id);
      const skipped = events.filter((event) => event.type === 'workspace.file_skipped');
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.payload).toMatchObject({ path: 'huge.bin', size: SPEC_FILE_LIMIT + 1, reason: 'too_large', limit_bytes: SPEC_FILE_LIMIT });
      // Recorded as part of that checkpoint, before its checkpoint.created.
      expect(skipped[0]?.seq).toBeLessThan(checkpoint.ledger_seq);
      expect(verifyChain(events)).toEqual({ ok: true });
    } finally {
      await fx.cleanup();
    }
  });

  it('tool output over 50 MB is truncated to 50 MB with truncated: true and the original byte length', async () => {
    const fx = await engineFixture();
    try {
      const run = await fx.engine.startRun({ agent: 'envelope-payload-limits' });
      const line = 'build ok: compiled module\n';
      const stdout = line.repeat(Math.ceil((SPEC_TOOL_OUTPUT_LIMIT + 64 * KB) / line.length));
      const originalBytes = Buffer.byteLength(stdout, 'utf8');
      expect(originalBytes).toBeGreaterThan(SPEC_TOOL_OUTPUT_LIMIT);

      const [event] = await fx.engine.record([
        {
          run_id: run.run_id,
          type: 'tool.completed',
          actor: 'runtime',
          intent_id: 'toolu_envelope_big_output',
          payload: { tool_call_id: 'toolu_envelope_big_output', stdout },
        },
      ]);
      expect(event).toBeDefined();
      // 50 MB is also over the inline limit, so the stored payload is read back from CAS.
      expect(event?.payload).toBeNull();
      expect(event?.payload_ref).not.toBeNull();
      const stored = JSON.parse((await readAll(await fx.backend.getBlob(event!.payload_ref!))).toString('utf8')) as Record<string, unknown>;

      expect(stored['truncated']).toBe(true);
      expect(stored['original_bytes']).toEqual({ '/stdout': originalBytes });
      expect(typeof stored['stdout']).toBe('string');
      expect(Buffer.byteLength(stored['stdout'] as string, 'utf8')).toBe(SPEC_TOOL_OUTPUT_LIMIT);
      expect(stored['stdout']).toBe(stdout.slice(0, SPEC_TOOL_OUTPUT_LIMIT)); // ASCII: bytes === chars
    } finally {
      await fx.cleanup();
    }
  });

  it('an event payload over 1 MB is stored as a CAS blob and the event carries its blob reference', async () => {
    const fx = await engineFixture();
    try {
      const run = await fx.engine.startRun({ agent: 'envelope-payload-limits' });

      // Control: a payload under the limit stays inline.
      const [small] = await fx.engine.record([{ run_id: run.run_id, type: 'context.built', actor: 'runtime', payload: { summary: 'small' } }]);
      expect(small?.payload).toEqual({ summary: 'small' });
      expect(small?.payload_ref).toBeNull();

      const summary = 'context line for the envelope test\n'.repeat(Math.ceil((SPEC_INLINE_PAYLOAD_LIMIT + 4 * KB) / 35));
      const [big] = await fx.engine.record([{ run_id: run.run_id, type: 'context.built', actor: 'runtime', payload: { summary } }]);
      expect(big?.payload).toBeNull();
      const ref = big?.payload_ref;
      expect(ref).toBeTruthy();
      expect(ref!.size).toBeGreaterThan(SPEC_INLINE_PAYLOAD_LIMIT);

      const bytes = await readAll(await fx.backend.getBlob(ref!));
      expect(bytes.byteLength).toBe(ref!.size);
      expect(sha256(bytes)).toBe(ref!.sha256);
      expect(JSON.parse(bytes.toString('utf8'))).toEqual({ summary });

      // The offloaded event is a normal member of the hash chain.
      const events = await allEvents(fx.backend, run.run_id);
      expect(events.find((event) => event.seq === big!.seq)).toEqual(big);
      expect(verifyChain(events)).toEqual({ ok: true });
    } finally {
      await fx.cleanup();
    }
  });

  it('an env value over 64 KB is truncated and keeps the fingerprint of the full value', async () => {
    const fx = await engineFixture();
    try {
      const run = await fx.engine.startRun({ agent: 'envelope-payload-limits' });
      const longSetting = 'segment/'.repeat(Math.ceil((SPEC_ENV_VALUE_LIMIT + 4 * KB) / 8));
      const longPath = '/usr/local/bin:'.repeat(Math.ceil((SPEC_ENV_VALUE_LIMIT + 4 * KB) / 15));
      expect(Buffer.byteLength(longSetting)).toBeGreaterThan(SPEC_ENV_VALUE_LIMIT);
      expect(Buffer.byteLength(longPath)).toBeGreaterThan(SPEC_ENV_VALUE_LIMIT);

      const [event] = await fx.engine.record([
        {
          run_id: run.run_id,
          type: 'agent.started',
          actor: 'runtime',
          payload: { env: { ENVELOPE_LONG_SETTING: longSetting, PATH: longPath, ENVELOPE_SHORT_SETTING: 'short' } },
        },
      ]);
      expect(event?.payload).not.toBeNull();
      const entries = (event?.payload as Record<string, unknown>)['env'] as EnvEntry[];
      const byName = new Map(entries.map((entry) => [entry.name, entry]));

      for (const [name, full] of [
        ['ENVELOPE_LONG_SETTING', longSetting],
        ['PATH', longPath],
      ] as const) {
        const entry = byName.get(name);
        expect(entry, name).toBeDefined();
        expect(entry?.classification, name).not.toBe('secret');
        expect(Buffer.byteLength(entry?.value ?? '', 'utf8'), name).toBe(SPEC_ENV_VALUE_LIMIT);
        expect(entry?.value, name).toBe(full.slice(0, SPEC_ENV_VALUE_LIMIT)); // ASCII: bytes === chars
        // The fingerprint covers the FULL value, not the stored truncation.
        expect(entry?.fingerprint, name).toBe(fingerprint(full));
        expect(entry?.fingerprint, name).not.toBe(fingerprint(entry?.value ?? ''));
      }
      expect(byName.get('ENVELOPE_SHORT_SETTING')).toMatchObject({ value: 'short', fingerprint: fingerprint('short') });
    } finally {
      await fx.cleanup();
    }
  });
});
