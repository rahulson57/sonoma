/**
 * Shared fixtures for the Claude Code Adapter unit tests (SPEC-009).
 *
 * FakeEngine stands in for the Checkpoint Engine and its ledger. It keeps the engine's record() contract: engine-owned
 * types are refused with ERR_RESERVED_EVENT, a type outside the 23-type enum or an unknown actor is refused, and a
 * payload must survive a JSON round-trip. That way a unit test fails exactly where the real engine would. The
 * integration tests (tests/integration/adapters/claude-code) use the real engine and LocalBackend.
 */
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { createHookHandler, RUN_ID_ENV, workspaceStatusOf, type HookHandler, type ReadWorkspaceStatus } from '../../../../src/adapters/claude-code/index.js';
import { ENGINE_OWNED_EVENT_TYPES } from '../../../../src/engine/index.js';
import { isLedgerActor, isLedgerEventType } from '../../../../src/ledger/event-types.js';
import type { Checkpoint, LedgerEvent, LedgerEventDraft } from '../../../../src/model/types.js';

export const RUN_ID = 'run_01JAAAAAAAAAAAAAAAAAAAAAAA';

/** File name (without .json) of each hook fixture under ./fixtures. */
export const FIXTURES = {
  SessionStart: 'session-start',
  SessionStartResume: 'session-start-resume',
  UserPromptSubmit: 'user-prompt-submit',
  PreToolUse: 'pre-tool-use',
  PostToolUse: 'post-tool-use',
  PostToolUseFailure: 'post-tool-use-failure',
  Stop: 'stop',
  SessionEnd: 'session-end',
} as const;

export type FixtureName = (typeof FIXTURES)[keyof typeof FIXTURES];

/** A fresh parsed copy of a hook fixture. */
export function fixture(name: FixtureName): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

/** The raw stdin text of a hook fixture. */
export function fixtureText(name: FixtureName): string {
  return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
}

export class EngineRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export class FakeEngine {
  readonly events: LedgerEvent[] = [];
  /** Run id of each checkpoint() call, in order. */
  readonly checkpoints: string[] = [];
  /** Every draft passed to record(), including refused ones. */
  readonly drafts: LedgerEventDraft[] = [];
  /** Return an error to make record() refuse that draft. */
  failRecord: ((draft: LedgerEventDraft) => Error | undefined) | undefined;
  failCheckpoint: (() => Error | undefined) | undefined;
  readonly workspace = '/fake/workspace';

  constructor(readonly runId: string = RUN_ID) {
    this.#push({ run_id: runId, type: 'run.created', actor: 'runtime', payload: { agent: 'claude-code', workspace: 'repo' } });
  }

  get types(): string[] {
    return this.events.map((event) => event.type);
  }

  /** Events appended after run.created. */
  get observed(): LedgerEvent[] {
    return this.events.slice(1);
  }

  #push(draft: LedgerEventDraft): LedgerEvent {
    const seq = this.events.length + 1;
    const event: LedgerEvent = {
      event_id: `evt_${String(seq).padStart(4, '0')}`,
      run_id: draft.run_id,
      seq,
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
      type: draft.type,
      actor: draft.actor,
      intent_id: draft.intent_id ?? null,
      payload: JSON.parse(JSON.stringify(draft.payload)) as Record<string, unknown>,
      payload_ref: null,
      prev_hash: '',
      hash: '',
    };
    this.events.push(event);
    return event;
  }

  async record(drafts: readonly LedgerEventDraft[]): Promise<LedgerEvent[]> {
    const sealed: LedgerEvent[] = [];
    for (const draft of drafts) {
      this.drafts.push(draft);
      if (draft.run_id !== this.runId) throw new EngineRefusal('ERR_NOT_FOUND', `run ${draft.run_id} does not exist`);
      if (!isLedgerEventType(draft.type)) throw new EngineRefusal('ERR_INVALID_INPUT', `unknown event type ${String(draft.type)}`);
      if (ENGINE_OWNED_EVENT_TYPES.has(draft.type)) throw new EngineRefusal('ERR_RESERVED_EVENT', `${draft.type} is engine-owned`);
      if (!isLedgerActor(draft.actor)) throw new EngineRefusal('ERR_INVALID_INPUT', `unknown actor ${String(draft.actor)}`);
      const injected = this.failRecord?.(draft);
      if (injected !== undefined) throw injected;
      sealed.push(this.#push(draft));
    }
    return sealed;
  }

  async checkpoint(runId: string): Promise<Checkpoint> {
    const injected = this.failCheckpoint?.();
    if (injected !== undefined) throw injected;
    this.checkpoints.push(runId);
    return { checkpoint_id: `c_${this.checkpoints.length}`, run_id: runId } as unknown as Checkpoint;
  }

  async workspaceDir(runId: string): Promise<string> {
    if (runId !== this.runId) throw new EngineRefusal('ERR_NOT_FOUND', `run ${runId} does not exist`);
    return this.workspace;
  }

  async getEvents(runId: string, range: { fromSeq: number; toSeq: number }): Promise<LedgerEvent[]> {
    if (runId !== this.runId) return [];
    return this.events.filter((event) => event.seq >= range.fromSeq && event.seq <= range.toSeq);
  }

  async getBlob(): Promise<Readable> {
    throw new Error('the fake ledger stores no blobs');
  }
}

/** A git status reader that returns the given porcelain outputs in turn (the last one repeats). */
export function scriptedStatus(outputs: readonly string[]): ReadWorkspaceStatus & { calls: string[] } {
  const calls: string[] = [];
  const reader = async (dir: string) => {
    calls.push(dir);
    const next = outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? '';
    return workspaceStatusOf(Buffer.from(next, 'utf8'));
  };
  return Object.assign(reader, { calls });
}

export interface Harness {
  readonly engine: FakeEngine;
  readonly handler: HookHandler;
  readonly status: ReturnType<typeof scriptedStatus>;
  /** Lines the handler wrote to its stderr sink. */
  readonly stderr: string[];
}

export function harness(options: { status?: readonly string[]; env?: Record<string, string | undefined> } = {}): Harness {
  const engine = new FakeEngine();
  const status = scriptedStatus(options.status ?? ['']);
  const stderr: string[] = [];
  const handler = createHookHandler({
    engine,
    ledger: engine,
    env: options.env ?? { [RUN_ID_ENV]: RUN_ID },
    readWorkspaceStatus: status,
    sleep: async () => undefined,
    stderr: (line) => stderr.push(line),
  });
  return { engine, handler, status, stderr };
}

/** Every object key anywhere in `value`, with its JSON-pointer-ish path. */
export function keysDeep(value: unknown, at = ''): Array<{ key: string; path: string }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => keysDeep(item, `${at}/${i}`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [{ key, path: `${at}/${key}` }, ...keysDeep(child, `${at}/${key}`)]);
}
