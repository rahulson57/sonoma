/**
 * Shared fixtures for the Distiller unit tests (SPEC-007). No git, no network: an in-memory run built
 * from tests/helpers/ledger.ts fakeLedgerEvents(), an in-memory CAS and a spying provider.
 */
import { createHash } from 'node:crypto';
import {
  BlobProjectionStore,
  createBudget,
  type DistillBudget,
  type DistillEvent,
  type DistillRequest,
  type DistillSource,
  type DistillerProvider,
  type ProviderUsage,
} from '../../../src/distill/index.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import type { AgentStateObject, BlobRef } from '../../../src/model/types.js';
import { fixedClock } from '../../helpers/clock.js';
import { fakeLedgerEvents } from '../../helpers/ledger.js';

export const START_MS = Date.UTC(2026, 8, 13, 12, 0, 0);
export const COMMIT = '87b805cfcd7f422dc6c23c57179d7c0929d3147d';
export const USAGE: ProviderUsage = { inputTokens: 1840, outputTokens: 212, costUsd: 0.0026 };

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** In-memory stand-in for the CAS half of StorageBackend. */
export class MemoryBlobs {
  readonly #blobs = new Map<string, Uint8Array>();

  async putBlob(data: Uint8Array): Promise<BlobRef> {
    const copy = Uint8Array.from(data);
    const ref = { sha256: sha256(copy), size: copy.byteLength };
    this.#blobs.set(ref.sha256, copy);
    return ref;
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array> {
    const data = this.#blobs.get(ref.sha256);
    if (data === undefined) throw new Error(`no blob ${ref.sha256}`);
    return Uint8Array.from(data);
  }
}

export interface SpyProvider extends DistillerProvider {
  /** Every prompt passed to complete(), in order. */
  readonly prompts: readonly string[];
}

export function spyProvider(text: string, options: { name?: string; model?: string; usage?: ProviderUsage } = {}): SpyProvider {
  const prompts: string[] = [];
  return {
    name: options.name ?? 'anthropic',
    model: options.model ?? 'claude-haiku-4-5-20251001',
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      return { text, usage: { ...(options.usage ?? USAGE) } };
    },
  };
}

/** A provider reply carrying `claims`. */
export function reply(claims: readonly unknown[]): string {
  return JSON.stringify({ claims });
}

type ProvenanceKey = 'event_ids' | 'artifact_refs' | 'workspace_paths' | 'checkpoint_ids';

export function provenance(lists: Partial<Record<ProvenanceKey, string[]>>): Record<ProvenanceKey, string[]> {
  return { event_ids: [], artifact_refs: [], workspace_paths: [], checkpoint_ids: [], ...lists };
}

export interface FakeRunOptions {
  readonly events: number;
  readonly prevCursor: number;
  readonly cursor: number;
  readonly seed?: number;
  /** Checkpoint ids the store holds. Default c_1, c_2. */
  readonly checkpoints?: readonly string[];
  /** Seqs whose payload is offloaded to a CAS blob (payload null, payload_ref set). */
  readonly offload?: readonly number[];
}

export interface FakeRun {
  readonly runId: string;
  readonly events: readonly DistillEvent[];
  readonly state: AgentStateObject;
  readonly request: DistillRequest;
  readonly blobs: MemoryBlobs;
  readonly source: DistillSource;
  /** What the distiller asked the source for. */
  readonly calls: { readState: number; readEvents: Array<{ fromSeq: number; toSeq: number }>; readBlob: string[] };
}

/** One run of `events` fake ledger events, distilling checkpoint c_2 over (prevCursor, cursor]. */
export async function fakeRun(options: FakeRunOptions): Promise<FakeRun> {
  const blobs = new MemoryBlobs();
  const raw = fakeLedgerEvents(options.events, options.seed ?? 7);
  const runId = raw[0]?.run_id ?? 'run_00000000000000000000000000';
  const offload = new Set(options.offload ?? []);
  const events: DistillEvent[] = [];
  for (const event of raw) {
    if (offload.has(event.seq)) {
      const ref = await blobs.putBlob(Buffer.from(canonicalJSON(event.payload), 'utf8'));
      events.push({ ...event, payload: null, payload_ref: ref });
    } else {
      events.push({ ...event, payload_ref: null });
    }
  }
  const state: AgentStateObject = {
    schemaVersion: 1,
    run_id: runId,
    checkpoint_id: 'c_2',
    ledger_seq: options.cursor,
    workspace_commit: COMMIT,
    pending_intent: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const stateHash = sha256(canonicalJSON(state));
  const known = new Set(options.checkpoints ?? ['c_1', 'c_2']);
  const calls: FakeRun['calls'] = { readState: 0, readEvents: [], readBlob: [] };
  const source: DistillSource = {
    runId,
    async readState(checkpointId) {
      calls.readState += 1;
      if (checkpointId !== state.checkpoint_id) throw new Error(`unknown checkpoint ${checkpointId}`);
      return { stateHash, state };
    },
    // Deliberately the WHOLE run, whatever the range: bounding the prompt is the distiller's job.
    async readEvents(range) {
      calls.readEvents.push({ fromSeq: range.fromSeq, toSeq: range.toSeq });
      return events;
    },
    async readBlob(ref) {
      calls.readBlob.push(ref.sha256);
      return blobs.getBlob(ref);
    },
    async hasCheckpoint(id) {
      return known.has(id);
    },
  };
  return {
    runId,
    events,
    state,
    blobs,
    source,
    calls,
    request: { checkpointId: 'c_2', stateHash, ledgerRange: [options.prevCursor, options.cursor], workspaceCommit: COMMIT },
  };
}

/** A source that fails the test if the distiller reads anything from it. */
export function untouchableSource(runId: string): DistillSource {
  const refuse = async (): Promise<never> => {
    throw new Error('the store must not be read');
  };
  return { runId, readState: refuse, readEvents: refuse, readBlob: refuse, hasCheckpoint: refuse };
}

export function depsFor(run: FakeRun, provider: DistillerProvider, budget?: DistillBudget) {
  let next = 0;
  return {
    provider,
    source: run.source,
    store: new BlobProjectionStore(run.blobs),
    budget: budget ?? createBudget(run.runId),
    clock: fixedClock(START_MS),
    newProjectionId: () => `proj_${++next}`,
  };
}

/** The events of a prompt's LEDGER section, parsed. */
export function ledgerLines(prompt: string): Array<Record<string, unknown>> {
  const lines = prompt.split('\n');
  const start = lines.findIndex((line) => line.startsWith('LEDGER ('));
  if (start === -1) throw new Error('prompt has no LEDGER section');
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(start + 1)) {
    if (line === '') break;
    out.push(JSON.parse(line) as Record<string, unknown>);
  }
  return out;
}

export function seqs(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
