import { describe, expect, it } from 'vitest';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { sha256Hex } from '../../../src/ledger/hash.js';
import { ExecutionLedger, MAX_INLINE_PAYLOAD_BYTES, type BlobSink } from '../../../src/ledger/ledger.js';
import { verifyChain } from '../../../src/ledger/verify-chain.js';
import { validateAgainst } from '../../../src/model/schemas.js';
import { validateEvent } from '../../../src/model/validate.js';

const RUN = 'run_01J8Z3K5QW7XV2M9N4P6R8T0AB';

function memoryBlobs(): { sink: BlobSink; stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  const sink: BlobSink = {
    async putBlob(data) {
      const sha256 = sha256Hex(data);
      stored.set(sha256, data.slice());
      return { sha256, size: data.byteLength };
    },
  };
  return { sink, stored };
}

function ledgerWith(sink: BlobSink): ExecutionLedger {
  let n = 0;
  return new ExecutionLedger({
    run_id: RUN,
    blobs: sink,
    clock: { now: () => Date.UTC(2026, 8, 13) },
    newEventId: () => `evt_${(n += 1)}`,
  });
}

/** `{"blob":"xxx…"}` whose canonical JSON is exactly `bytes` UTF-8 bytes long. */
function payloadOfBytes(bytes: number): { blob: string } {
  return { blob: 'x'.repeat(bytes - '{"blob":""}'.length) };
}

describe('inline payload limit (SPEC-004 / SPEC-002: ≤ 1 MB inline, larger → blob)', () => {
  it('the inline limit is 1 MiB of canonical JSON', () => {
    expect(MAX_INLINE_PAYLOAD_BYTES).toBe(1_048_576);
    expect(Buffer.byteLength(canonicalJSON(payloadOfBytes(MAX_INLINE_PAYLOAD_BYTES)), 'utf8')).toBe(MAX_INLINE_PAYLOAD_BYTES);
  });

  it('a payload larger than 1 MB is stored as payload_ref and the inline payload is null', async () => {
    const { sink, stored } = memoryBlobs();
    const payload = payloadOfBytes(MAX_INLINE_PAYLOAD_BYTES + 1);
    const event = await ledgerWith(sink).append({ run_id: RUN, type: 'tool.completed', actor: 'runtime', payload });

    expect(event.payload).toBeNull();
    const bytes = Buffer.from(canonicalJSON(payload), 'utf8');
    expect(event.payload_ref).toEqual({ sha256: sha256Hex(bytes), size: bytes.byteLength });
    expect(Buffer.from(stored.get(event.payload_ref!.sha256)!).equals(bytes)).toBe(true);

    expect(validateEvent(event).ok).toBe(true);
    expect(verifyChain([event])).toEqual({ ok: true });
  });

  it('a payload of exactly 1 MB stays inline and never touches the blob sink', async () => {
    const { sink, stored } = memoryBlobs();
    const payload = payloadOfBytes(MAX_INLINE_PAYLOAD_BYTES);
    const event = await ledgerWith(sink).append({ run_id: RUN, type: 'tool.completed', actor: 'runtime', payload });
    expect(event.payload_ref).toBeNull();
    expect(event.payload).toEqual(payload);
    expect(stored.size).toBe(0);
  });

  it('measures UTF-8 bytes, not characters', async () => {
    const { sink } = memoryBlobs();
    const payload = { text: 'é'.repeat(600_000) }; // 600,000 characters, 1,200,000 bytes
    const event = await ledgerWith(sink).append({ run_id: RUN, type: 'model.responded', actor: 'runtime', payload });
    expect(event.payload).toBeNull();
    expect(event.payload_ref?.size).toBe(1_200_000 + '{"text":""}'.length);
  });

  it('a small payload is inline with a null payload_ref', async () => {
    const { sink, stored } = memoryBlobs();
    const event = await ledgerWith(sink).append({ run_id: RUN, type: 'agent.started', actor: 'runtime', payload: { ok: true } });
    expect(event.payload).toEqual({ ok: true });
    expect(event.payload_ref).toBeNull();
    expect(stored.size).toBe(0);
  });

  it('rejects a blob sink whose reference does not match the bytes, without advancing the head', async () => {
    const lying: BlobSink = {
      async putBlob(data) {
        return { sha256: '0'.repeat(64), size: data.byteLength };
      },
    };
    const ledger = ledgerWith(lying);
    await expect(
      ledger.append({ run_id: RUN, type: 'tool.completed', actor: 'runtime', payload: payloadOfBytes(MAX_INLINE_PAYLOAD_BYTES + 1) }),
    ).rejects.toMatchObject({ code: 'ERR_BLOB_REF_MISMATCH' });
    expect(ledger.head.seq).toBe(0);
  });

  it('the event schema refuses an inline payload next to a payload_ref, and a blob ref under the limit', async () => {
    const { sink } = memoryBlobs();
    const event = await ledgerWith(sink).append({ run_id: RUN, type: 'agent.started', actor: 'runtime', payload: {} });
    const ref = { sha256: 'c'.repeat(64), size: MAX_INLINE_PAYLOAD_BYTES + 5 };
    expect(validateAgainst('ledgerEvent', { ...event, payload_ref: ref }).ok).toBe(false);
    expect(validateAgainst('ledgerEvent', { ...event, payload: null, payload_ref: ref }).ok).toBe(true);
    expect(validateAgainst('ledgerEvent', { ...event, payload: null, payload_ref: { ...ref, size: 10 } }).ok).toBe(false);
  });
});
