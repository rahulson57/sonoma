/**
 * SPEC-012 display policy: a blob payload over 64 KB is shown as a `sha256:` ref with size, not inlined; redacted values
 * render as the stored `[REDACTED:<kind>]` marker; the UI only reads already-redacted stored data and never serves raw
 * secret bytes (SPEC-003).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { MAX_INLINE_PAYLOAD_BYTES } from '../../../src/ledger/ledger.js';
import type { LedgerEvent } from '../../../src/model/types.js';
import { MAX_INLINE_DISPLAY_BYTES, type CheckpointPanes, type TimelineNode } from '../../../src/ui/index.js';
import { secretCorpus } from '../../helpers/fakeSecrets.js';
import {
  buildForkFixture,
  checkpointPath,
  everyGetPath,
  missingPaths,
  openInspector,
  sha256,
  type ForkFixture,
  type InspectorFixture,
} from './support.js';

/** Over 64 KB, under the ledger's 1 MiB inline limit: stored inline, displayed as a ref. */
const BIG_INLINE_STDOUT = 'lorem ipsum dolor sit amet '.repeat(2_700);
/** Over the 1 MiB inline limit: stored as a CAS blob (payload_ref). */
const OFFLOADED_STDOUT = 'z'.repeat(MAX_INLINE_PAYLOAD_BYTES + 4_096);

const corpus = secretCorpus();
const allSecrets = corpus.map((sample) => sample.value).join('\n');
const firstOf = (kind: string): string => corpus.find((sample) => sample.kind === kind)?.value ?? '';

/** Every substring that would betray a corpus value: the value, its JSON-escaped form, and each long line of it. */
function leakNeedles(): Array<{ kind: string; needle: string }> {
  const needles: Array<{ kind: string; needle: string }> = [];
  for (const { kind, value } of corpus) {
    needles.push({ kind, needle: value }, { kind, needle: JSON.stringify(value).slice(1, -1) });
    for (const line of value.split('\n')) {
      if (line.length >= 16 && !line.startsWith('-----')) needles.push({ kind, needle: line });
    }
  }
  return needles;
}

function eventAt(events: readonly LedgerEvent[], index: number): LedgerEvent {
  const event = events[index];
  if (event === undefined) throw new Error(`fixture event ${index} missing`);
  return event;
}

describe('display policy', () => {
  let fx: ForkFixture;
  let ui: InspectorFixture;

  beforeAll(async () => {
    fx = await buildForkFixture({
      c2Label: `release ${firstOf('github')}`,
      c2Observations: (runId) => [
        { run_id: runId, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_secret', tool_name: 'Bash', input: { command: `deploy --token ${firstOf('slack')}` } } },
        { run_id: runId, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_secret', stdout: allSecrets, stderr: allSecrets } },
        { run_id: runId, type: 'context.built', actor: 'runtime', payload: { env: { AWS_SECRET_ACCESS_KEY: firstOf('aws'), PATH: '/usr/bin' } } },
        { run_id: runId, type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: 'se_hook', type: 'webhook.post', target: `hook ${firstOf('jwt')}` } },
        { run_id: runId, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_big', tool_name: 'Cat' } },
        { run_id: runId, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_big', stdout: BIG_INLINE_STDOUT } },
        { run_id: runId, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_offloaded', stdout: OFFLOADED_STDOUT } },
      ],
    });
    ui = await openInspector(fx.repo.dir);
  });

  afterAll(async () => {
    await ui?.close();
    await fx?.cleanup();
  });

  it('a payload over 64 KB is rendered as a sha256 ref with its size, not inlined', async () => {
    expect(MAX_INLINE_DISPLAY_BYTES).toBe(64 * 1024);
    const res = await ui.request(checkpointPath(fx.c2));
    expect(res.status).toBe(200);
    const panes = res.json as CheckpointPanes;
    const shown = (seq: number) => panes.ledger.events.find((event) => event.seq === seq);

    // Inline in the ledger (under 1 MiB) but over 64 KB: the sha256 of its canonical JSON bytes, and their size.
    const big = eventAt(fx.c2Extra, 5);
    expect(big.payload_ref).toBeNull();
    const bigJson = canonicalJSON(big.payload);
    expect(Buffer.byteLength(bigJson)).toBeGreaterThan(MAX_INLINE_DISPLAY_BYTES);
    expect(shown(big.seq)).toEqual({
      seq: big.seq,
      type: 'tool.completed',
      actor: 'runtime',
      ts: big.ts,
      payload: null,
      payloadRef: { ref: `sha256:${sha256(bigJson)}`, size: Buffer.byteLength(bigJson) },
    });

    // Offloaded to CAS (over 1 MiB): its stored BlobRef.
    const offloaded = eventAt(fx.c2Extra, 6);
    expect(offloaded.payload).toBeNull();
    const blob = offloaded.payload_ref;
    expect(blob).not.toBeNull();
    expect(shown(offloaded.seq)).toMatchObject({ payload: null, payloadRef: { ref: `sha256:${blob?.sha256}`, size: blob?.size } });

    // Small payloads stay inline.
    const small = eventAt(fx.c2Extra, 4);
    expect(shown(small.seq)).toMatchObject({ payload: small.payload, payloadRef: null });

    // Neither large payload's bytes are in the response.
    expect(res.text).not.toContain('lorem ipsum dolor sit amet lorem ipsum dolor sit amet');
    expect(res.text).not.toContain('z'.repeat(256));
    expect(Buffer.byteLength(res.text)).toBeLessThan(MAX_INLINE_DISPLAY_BYTES);
  });

  it('no response contains raw bytes from secretCorpus(); redacted values render as their stored marker', async () => {
    const bodies: Array<[string, string]> = [];
    for (const pathName of [...everyGetPath(fx), ...missingPaths(fx)]) {
      const res = await ui.request(pathName);
      bodies.push([pathName, res.text]);
    }

    // The secret-bearing events, label and side effect were served, as their redacted forms.
    const pane = JSON.parse(bodies.find(([pathName]) => pathName === checkpointPath(fx.c2))?.[1] ?? '{}') as CheckpointPanes;
    expect(JSON.stringify(eventAt(fx.c2Extra, 1).payload)).toContain('[REDACTED:');
    expect(pane.ledger.events.find((event) => event.seq === eventAt(fx.c2Extra, 1).seq)?.payload).toEqual(eventAt(fx.c2Extra, 1).payload);
    expect(pane.ledger.sideEffects.some((effect) => effect.type === 'webhook.post' && effect.target.includes('[REDACTED:'))).toBe(true);
    const timeline = JSON.parse(bodies.find(([pathName]) => pathName === `/api/runs/${fx.source.run_id}/checkpoints`)?.[1] ?? '[]') as TimelineNode[];
    expect(timeline.find((node) => node.checkpointId.endsWith(':c_2'))?.label).toMatch(/^release \[REDACTED:/);

    const leaks: string[] = [];
    for (const [pathName, body] of bodies) {
      for (const { kind, needle } of leakNeedles()) {
        if (body.includes(needle)) leaks.push(`${kind} in ${pathName}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
