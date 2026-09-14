/**
 * Unit fixtures for the Context Builder (SPEC-008): hash-chained ledger events, checkpoints and states that pass
 * the SPEC-004 validators, an in-memory read-only storage that records every range it is asked for, fake claim
 * sources and a fake git diff. No filesystem, git process, clock or network.
 */
import { createHash } from 'node:crypto';
import type { ClaimSource, ContextGit, ContextStorage, RestoredCheckpointInput, ResumeContext } from '../../../src/context/index.js';
import type { NameStatus } from '../../../src/engine/types.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { GENESIS_PREV_HASH, chainHash } from '../../../src/ledger/hash.js';
import { derivePendingIntent } from '../../../src/ledger/pending-intent.js';
import type {
  AgentStateObject,
  BlobRef,
  Checkpoint,
  ClaimOrigin,
  JsonPayload,
  LedgerActor,
  LedgerEvent,
  LedgerEventType,
  PendingIntent,
  SemanticClaim,
  SemanticField,
  SemanticProjection,
} from '../../../src/model/types.js';
import type { CheckpointRef } from '../../../src/storage/types.js';
import { fakeLedgerEvents } from '../../helpers/ledger.js';

export const START_MS = Date.UTC(2026, 8, 13, 9, 0, 0);
export const RUN_ID = `run_${'0'.repeat(25)}A`;
export const WORKTREE = '/tmp/ckpt-context-fixture/worktree';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function commitFor(label: string): string {
  return sha256(`commit:${label}`).slice(0, 40);
}

export interface Draft {
  readonly type: LedgerEventType;
  readonly payload: JsonPayload | null;
  readonly actor?: LedgerActor;
  readonly payload_ref?: BlobRef | null;
  readonly event_id?: string;
}

const TOOL_INTENT_TYPES: ReadonlySet<LedgerEventType> = new Set<LedgerEventType>(['tool.requested', 'tool.completed', 'tool.failed']);

/**
 * The top-level intent_id of a sealed fixture event (SPEC-015 amendment 2). A tool.requested / tool.completed /
 * tool.failed event carries the payload tool_call_id the fixture already pairs it by. Every other event carries null,
 * and so does an offloaded acknowledgement (payload null), which has no id to read. Correlation is therefore exactly
 * what the payload fallback in derivePendingIntent already produced before the amendment.
 */
function intentIdOf(draft: Draft): string | null {
  if (!TOOL_INTENT_TYPES.has(draft.type)) return null;
  const id = draft.payload?.['tool_call_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Seal drafts into a contiguous, hash-chained ledger starting at seq 1. The hash covers intent_id, as src/ledger's does. */
export function sealEvents(drafts: readonly Draft[], runId: string = RUN_ID): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  let prev = GENESIS_PREV_HASH;
  drafts.forEach((draft, index) => {
    const seq = index + 1;
    const body = {
      event_id: draft.event_id ?? `evt_${String(seq).padStart(6, '0')}`,
      run_id: runId,
      seq,
      ts: new Date(START_MS + seq * 1000).toISOString(),
      type: draft.type,
      actor: draft.actor ?? 'runtime',
      intent_id: intentIdOf(draft),
      payload: draft.payload,
      payload_ref: draft.payload_ref ?? null,
      prev_hash: prev,
    };
    const hash = chainHash(prev, body);
    events.push({ ...body, hash });
    prev = hash;
  });
  return events;
}

/** tests/helpers fakeLedgerEvents(n, seed), sealed into canonical LedgerEvents. */
export function sealFakeLedger(n: number, seed: number): LedgerEvent[] {
  const fake = fakeLedgerEvents(n, seed);
  const runId = fake[0]?.run_id ?? RUN_ID;
  return sealEvents(
    fake.map((event) => ({ type: event.type, actor: event.actor, payload: event.payload, event_id: event.event_id })),
    runId,
  );
}

export function checkpointAt(options: { n: number; ledgerSeq: number; parent?: Checkpoint | null; runId?: string; label?: string | null }): Checkpoint {
  const runId = options.runId ?? options.parent?.run_id ?? RUN_ID;
  const stateHash = sha256(`state:${runId}:${options.n}`);
  return {
    schemaVersion: 1,
    checkpoint_id: `c_${options.n}`,
    run_id: runId,
    parent_checkpoint_id: options.parent?.checkpoint_id ?? null,
    label: options.label ?? null,
    state_blob: { sha256: stateHash, size: 256 },
    state_hash: stateHash,
    workspace_commit: commitFor(`${runId}:${options.n}`),
    ledger_seq: options.ledgerSeq,
    usage: { input_tokens: 1200, output_tokens: 340 },
    created_at: new Date(START_MS + options.n * 60_000).toISOString(),
  };
}

export function stateFor(checkpoint: Checkpoint, pendingIntent: readonly PendingIntent[]): AgentStateObject {
  return {
    schemaVersion: 1,
    run_id: checkpoint.run_id,
    checkpoint_id: checkpoint.checkpoint_id,
    ledger_seq: checkpoint.ledger_seq,
    workspace_commit: checkpoint.workspace_commit,
    pending_intent: [...pendingIntent],
    usage: { input_tokens: 1200, output_tokens: 340 },
  };
}

/** The restored checkpoint as the engine hands it over, with pending intent derived from the events up to the cursor. */
export function restoredAt(checkpoint: Checkpoint, events: readonly LedgerEvent[], extra: Partial<RestoredCheckpointInput> = {}): RestoredCheckpointInput {
  const upTo = events.filter((event) => event.run_id === checkpoint.run_id && event.seq <= checkpoint.ledger_seq);
  return { checkpoint, state: stateFor(checkpoint, derivePendingIntent(upTo)), worktreePath: WORKTREE, ...extra };
}

/** The list the builder renders: the engine's pendingIntent when supplied, else state.pending_intent (DEC-036(2)). */
export function renderedList(restored: RestoredCheckpointInput): readonly PendingIntent[] {
  return restored.pendingIntent ?? restored.state.pending_intent;
}

/** Read-only in-memory storage. Records every getEvents range and getCheckpoint ref. */
export class MemoryStorage implements ContextStorage {
  readonly ranges: Array<{ readonly runId: string; readonly fromSeq: number; readonly toSeq: number }> = [];
  readonly checkpointReads: CheckpointRef[] = [];
  readonly #events = new Map<string, LedgerEvent[]>();
  /** Keyed `run_id:checkpoint_id`, first occurrence wins, so deep lineages read in constant time per checkpoint. */
  readonly #checkpoints = new Map<string, Checkpoint>();

  constructor(events: readonly LedgerEvent[], checkpoints: readonly Checkpoint[]) {
    for (const event of events) {
      const list = this.#events.get(event.run_id) ?? [];
      list.push(event);
      this.#events.set(event.run_id, list);
    }
    for (const list of this.#events.values()) {
      list.sort((a, b) => a.seq - b.seq);
      list.forEach((event, index) => {
        if (event.seq !== index + 1) throw new Error(`MemoryStorage: ledger of ${event.run_id} is not contiguous from seq 1`);
      });
    }
    for (const checkpoint of checkpoints) {
      const key = keyOf(checkpoint);
      if (!this.#checkpoints.has(key)) this.#checkpoints.set(key, checkpoint);
    }
  }

  async getEvents(runId: string, range: { fromSeq: number; toSeq: number }): Promise<LedgerEvent[]> {
    this.ranges.push({ runId, fromSeq: range.fromSeq, toSeq: range.toSeq });
    const list = this.#events.get(runId) ?? [];
    return list.slice(Math.max(0, range.fromSeq - 1), Math.max(0, range.toSeq));
  }

  async getCheckpoint(ref: CheckpointRef): Promise<Checkpoint> {
    this.checkpointReads.push(ref);
    const found = this.#checkpoints.get(`${ref.run_id}:${ref.checkpoint_id}`);
    if (found === undefined) throw new Error(`MemoryStorage: no checkpoint ${ref.run_id}:${ref.checkpoint_id}`);
    return found;
  }
}

/** `git diff --name-status a b` from a table keyed by `a..b`; unknown pairs have no changes. */
export function fakeGit(changes: Readonly<Record<string, readonly NameStatus[]>> = {}): ContextGit & { readonly calls: Array<readonly [string, string]> } {
  const calls: Array<readonly [string, string]> = [];
  return {
    calls,
    async diffNameStatus(a: string, b: string) {
      calls.push([a, b]);
      return changes[`${a}..${b}`] ?? [];
    },
  };
}

export function claim(field: SemanticField, value: string, eventIds: readonly string[], origin: ClaimOrigin = 'distilled'): SemanticClaim {
  return { field, value, origin, provenance: { event_ids: [...eventIds], artifact_refs: [], workspace_paths: [], checkpoint_ids: [] } };
}

export function keyOf(checkpoint: Checkpoint): string {
  return `${checkpoint.run_id}:${checkpoint.checkpoint_id}`;
}

/** A valid SemanticProjection of `checkpoint` holding `claims`. */
export function projectionOf(checkpoint: Checkpoint, claims: readonly SemanticClaim[], id = `proj_${keyOf(checkpoint)}`): SemanticProjection {
  return {
    id,
    checkpointId: checkpoint.checkpoint_id,
    source: 'distilled',
    distiller: { provider: 'fake', model: 'fake-model', promptVersion: 'distill-v1' },
    input: { stateHash: checkpoint.state_hash, ledgerRange: [0, checkpoint.ledger_seq], workspaceCommit: checkpoint.workspace_commit },
    claims: [...claims],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    createdAt: new Date(START_MS).toISOString(),
  };
}

/** Every checkpoint has one projection holding `claims`. Records every checkpoint asked. */
export function staticClaims(claims: readonly SemanticClaim[]): ClaimSource & { readonly checkpoints: Checkpoint[] } {
  const checkpoints: Checkpoint[] = [];
  return {
    checkpoints,
    async claimsAt(checkpoint: Checkpoint) {
      checkpoints.push(checkpoint);
      return { projections: [projectionOf(checkpoint, claims)], declared: [] };
    },
  };
}

export interface RecordedClaims {
  /** Claims of each projection, oldest projection first. */
  readonly projections?: ReadonlyArray<readonly SemanticClaim[]>;
  readonly declared?: readonly SemanticClaim[];
}

/** Claims recorded per checkpoint, keyed `run_id:checkpoint_id`; every other checkpoint has none. Records each key asked. */
export function claimTable(table: Readonly<Record<string, RecordedClaims>>): ClaimSource & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async claimsAt(checkpoint: Checkpoint) {
      const key = keyOf(checkpoint);
      asked.push(key);
      const entry = table[key];
      return {
        projections: (entry?.projections ?? []).map((claims, index) => projectionOf(checkpoint, claims, `proj_${key}_${index}`)),
        declared: [...(entry?.declared ?? [])],
      };
    },
  };
}

/** The lines under `heading:` in a preamble (every following line indented by two spaces). */
export function sectionLines(preamble: string, heading: string): string[] {
  const lines = preamble.split('\n');
  const start = lines.indexOf(`${heading}:`);
  if (start < 0) throw new Error(`preamble has no "${heading}:" section`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('  ')) break;
    out.push(line);
  }
  return out;
}

/** The character count tokenEstimate is defined over (DEC-036(4)): canonical JSON of every member except tokenEstimate. */
export function contextChars(context: ResumeContext, hydratedEvents: readonly LedgerEvent[] = context.hydratedEvents): number {
  const { systemPreamble, state, workspaceCommit } = context;
  return canonicalJSON({ systemPreamble, state, workspaceCommit, hydratedEvents }).length;
}

/** The omitted count a preamble line states, or 0 when there is no such line. */
export function omittedCount(preamble: string, what: 'completed tool actions' | 'failed tool actions'): number {
  const match = new RegExp(` {2}- (\\d+) ${what} omitted`).exec(preamble);
  return Number(match?.[1] ?? 0);
}
