/**
 * handleHook(payload): one Claude Code hook invocation → the observations of the HookMapping, appended through the
 * Checkpoint Engine's record(), plus an automatic checkpoint at Stop and SessionEnd.
 *
 * Never blocks the agent (SPEC-009): handleHook never rejects. A malformed payload, an unmapped hook, or any failure
 * while recording or checkpointing is appended as `adapter.error` / `adapter.unknown_hook` instead, and the `ckpt hook`
 * process exits 0 whatever this resolves to. It resolves to the id of the hook's primary event once that is appended
 * (a later failure in the same invocation, e.g. its workspace.changed or its checkpoint, is recorded as adapter.error but
 * does not change the result), to the adapter.error that replaced a primary event that could not be appended, or to
 * null when nothing was appended:
 * - the invocation is not bound to a run (no CKPT_RUN_ID, DEC-044 / Q-026 default 3). This path is silent and touches
 *   nothing; `boundRunId()` lets the caller check it before opening a store at all;
 * - the store refused even the adapter.error. The observation is then LOST: without the run's writer lock nothing can
 *   be appended, so a tool intent stays in_progress (outcome unknown), which is the safe direction. One line naming the
 *   hook and the error code (never payload data) goes to stderr, and nothing is written anywhere else.
 *
 * Owns no state: the run comes from the environment, and a PostToolUse finds its PreToolUse's workspace status in the
 * ledger. Payloads are handed to record() raw (the engine sanitizes before anything persists); nothing is logged.
 */
import { isStorageError } from '../../storage/errors.js';
import type { LedgerEvent } from '../../model/types.js';
import { isErrorResponse, isPlainObject, parseHookPayload, type ParsedHook } from './hook-payload.js';
import {
  adapterError,
  agentSuspended,
  promptSubmitted,
  sessionStarted,
  toolCompleted,
  toolFailed,
  toolFailedResponse,
  toolRequested,
  unknownHook,
  workspaceChanged,
  type Observation,
} from './mapping.js';
import { RUN_ID_ENV, WORKSPACE_TOOLS, type AdapterEngine, type AdapterLedgerReader, type EventId } from './types.js';
import { readWorkspaceStatus as gitWorkspaceStatus, type ReadWorkspaceStatus, type WorkspaceStatus } from './workspace-status.js';

/** How far back a PostToolUse looks for its PreToolUse (events), and the page size of that walk. */
export const MAX_REQUEST_SCAN = 4096;
const SCAN_PAGE = 64;

/**
 * ERR_RUN_LOCKED retry (DEC-044 / Q-026 default 7): a fixed, deterministic delay between attempts, and a total wait
 * of at most MAX_LOCK_WAIT_MS (≤ 5 s) per handleHook invocation. The budget is shared by every write, the boundary
 * checkpoint and the adapter.error attempt of that invocation; once it is spent, each remaining step gets one attempt
 * with no further wait.
 */
export const MAX_LOCK_WAIT_MS = 2000;
export const LOCK_RETRY_DELAY_MS = 50;
export const DEFAULT_LOCK_RETRY: LockRetryPolicy = Object.freeze({ maxWaitMs: MAX_LOCK_WAIT_MS, delayMs: LOCK_RETRY_DELAY_MS });

export interface LockRetryPolicy {
  /** Total sleep one handleHook invocation may spend waiting for the run lock. */
  readonly maxWaitMs: number;
  /** Sleep between attempts; must be positive. */
  readonly delayMs: number;
}

export interface HookHandlerOptions {
  readonly engine: AdapterEngine;
  readonly ledger: AdapterLedgerReader;
  /** Where CKPT_RUN_ID is read from. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readWorkspaceStatus?: ReadWorkspaceStatus;
  readonly lockRetry?: LockRetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Receives the one-line notice for a lost observation. Default: process.stderr. Never stdout. */
  readonly stderr?: (line: string) => void;
}

export interface HookHandler {
  handleHook(payload: unknown): Promise<EventId | null>;
}

/** The run a hook invocation is bound to, or null when it is not bound (plain `claude` with hooks installed). */
export function boundRunId(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[RUN_ID_ENV];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultStderr(line: string): void {
  process.stderr.write(line);
}

/** An error's code or class name: identifies the failure without echoing any value it may carry. */
function errorKind(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return err instanceof Error ? err.name : typeof err;
}

/** One handleHook invocation: the run it is bound to, and how much of its lock-wait budget it has slept. */
interface Invocation {
  readonly runId: string;
  waitedMs: number;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function createHookHandler(options: HookHandlerOptions): HookHandler {
  const { engine, ledger } = options;
  const env = options.env ?? process.env;
  const readStatus = options.readWorkspaceStatus ?? gitWorkspaceStatus;
  const retry = options.lockRetry ?? DEFAULT_LOCK_RETRY;
  if (!(Number.isFinite(retry.delayMs) && retry.delayMs > 0) || !(Number.isFinite(retry.maxWaitMs) && retry.maxWaitMs >= 0)) {
    throw new TypeError('lockRetry needs a positive delayMs and a non-negative maxWaitMs');
  }
  const sleep = options.sleep ?? defaultSleep;
  const stderr = options.stderr ?? defaultStderr;

  /**
   * Storage takes a run's writer lock per process and fails fast; another hook process may hold it briefly. Every
   * retry in one invocation draws on the same budget, so the invocation sleeps at most retry.maxWaitMs in total.
   */
  async function withLockRetry<T>(call: Invocation, fn: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!isStorageError(err, 'ERR_RUN_LOCKED') || call.waitedMs + retry.delayMs > retry.maxWaitMs) throw err;
        call.waitedMs += retry.delayMs;
        await sleep(retry.delayMs);
      }
    }
  }

  async function append(call: Invocation, observation: Observation): Promise<LedgerEvent> {
    const [event] = await withLockRetry(call, () => engine.record([{ run_id: call.runId, ...observation }]));
    if (event === undefined) throw new Error('record() appended nothing');
    return event;
  }

  /** Append adapter.error. When even that fails, the observation is lost: say so on stderr and resolve null. */
  async function appendError(call: Invocation, hook: string | null, stage: string, err: unknown): Promise<EventId | null> {
    try {
      return (await append(call, adapterError(hook, stage, err))).event_id;
    } catch (appendErr) {
      try {
        stderr(`ckpt hook ${hook ?? '(unparsed)'}: observation not recorded (${errorKind(appendErr)})\n`);
      } catch {
        // a closed stderr must not block the agent either
      }
      return null;
    }
  }

  /** Never rejects: an unreadable status is returned as its error, for the caller to record after its own event. */
  async function statusOf(runId: string): Promise<{ status: WorkspaceStatus | null; error: unknown }> {
    try {
      return { status: await readStatus(await engine.workspaceDir(runId)), error: undefined };
    } catch (err) {
      return { status: null, error: err };
    }
  }

  function statusFromPayload(payload: unknown): string | null {
    const value = isPlainObject(payload) ? payload['workspace_status'] : undefined;
    return typeof value === 'string' ? value : null;
  }

  /** The `workspace_status` recorded on the tool.requested with this intent id, searching back from `beforeSeq`. */
  async function requestedStatus(runId: string, toolUseId: string | null, beforeSeq: number): Promise<string | null> {
    if (toolUseId === null) return null;
    const floor = Math.max(1, beforeSeq - MAX_REQUEST_SCAN);
    for (let to = beforeSeq - 1; to >= floor; ) {
      const from = Math.max(floor, to - SCAN_PAGE + 1);
      const events = await ledger.getEvents(runId, { fromSeq: from, toSeq: to });
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event === undefined || event.type !== 'tool.requested' || (event.intent_id ?? null) !== toolUseId) continue;
        if (event.payload !== null) return statusFromPayload(event.payload);
        // An input over the inline limit was offloaded to CAS; its canonical JSON still carries the digest.
        if (event.payload_ref === null) return null;
        return statusFromPayload(JSON.parse((await readAll(await ledger.getBlob(event.payload_ref))).toString('utf8')) as unknown);
      }
      to = from - 1;
    }
    return null;
  }

  async function sessionStart(call: Invocation, hook: Extract<ParsedHook, { kind: 'SessionStart' }>): Promise<EventId> {
    // Decided from the run's ledger (DEC-044(1)): the first SessionStart of a run started by run() finds nothing after
    // the run.created that startRun() emitted, and resolves to it.
    const head = await ledger.getEvents(call.runId, { fromSeq: 1, toSeq: 2 });
    const first = head[0];
    if (head.length === 1 && first !== undefined && first.type === 'run.created') return first.event_id;
    return (await append(call, sessionStarted(hook))).event_id;
  }

  async function preToolUse(call: Invocation, hook: Extract<ParsedHook, { kind: 'PreToolUse' }>): Promise<EventId> {
    // The before-status must be read before the tool runs, so it precedes the append that carries it.
    const observed = WORKSPACE_TOOLS.has(hook.tool) ? await statusOf(call.runId) : { status: null, error: undefined };
    const event = await append(call, toolRequested(hook, observed.status?.digest ?? null));
    if (observed.error !== undefined) await appendError(call, hook.kind, 'workspace_status', observed.error);
    return event.event_id;
  }

  async function postToolUse(call: Invocation, hook: Extract<ParsedHook, { kind: 'PostToolUse' }>): Promise<EventId> {
    if (isErrorResponse(hook.response)) return (await append(call, toolFailedResponse(hook))).event_id;
    if (!WORKSPACE_TOOLS.has(hook.tool)) return (await append(call, toolCompleted(hook))).event_id;

    // The tool has already run, so its after-status can be read while tool.completed is appended: the hook then takes
    // about max(record, git status) rather than their sum. statusOf is started FIRST on purpose. The engine serializes
    // workspaceDir() behind record() per run, so started second it would wait for the append and git status would
    // run after it. Appending tool.completed cannot move the workspace directory (only resume, rollback and fork
    // events do), and the store directory the append writes to is excluded from the status. statusOf never rejects,
    // so it is safe to leave pending if the append throws.
    const observing = statusOf(call.runId);
    const completed = await append(call, toolCompleted(hook));
    const observed = await observing;
    if (observed.status === null) {
      await appendError(call, hook.kind, 'workspace_status', observed.error);
      return completed.event_id;
    }
    try {
      // Only a change known against the PreToolUse status is reported; the next checkpoint captures the workspace anyway.
      const before = await requestedStatus(call.runId, hook.toolUseId, completed.seq);
      if (before !== null && before !== observed.status.digest) {
        await append(call, workspaceChanged(hook, before, observed.status));
      }
    } catch (err) {
      // tool.completed is already in the ledger: it stays the result, and the missed workspace.changed is recorded.
      await appendError(call, hook.kind, 'record', err);
    }
    return completed.event_id;
  }

  async function boundary(call: Invocation, hook: Extract<ParsedHook, { kind: 'Stop' | 'SessionEnd' }>): Promise<EventId> {
    const suspended = await append(call, agentSuspended(hook));
    try {
      // Automatic checkpoint: no label, so no distillation request (SPEC-002: automatic checkpoints never call an LLM).
      await withLockRetry(call, () => engine.checkpoint(call.runId));
    } catch (err) {
      await appendError(call, hook.kind, 'checkpoint', err);
    }
    return suspended.event_id;
  }

  async function dispatch(call: Invocation, hook: ParsedHook): Promise<EventId> {
    switch (hook.kind) {
      case 'unknown':
        return (await append(call, unknownHook(hook))).event_id;
      case 'SessionStart':
        return sessionStart(call, hook);
      case 'UserPromptSubmit':
        return (await append(call, promptSubmitted(hook))).event_id;
      case 'PreToolUse':
        return preToolUse(call, hook);
      case 'PostToolUse':
        return postToolUse(call, hook);
      case 'PostToolUseFailure':
        return (await append(call, toolFailed(hook))).event_id;
      case 'Stop':
      case 'SessionEnd':
        return boundary(call, hook);
    }
  }

  return {
    async handleHook(payload: unknown): Promise<EventId | null> {
      const runId = boundRunId(env);
      if (runId === null) return null;
      const call: Invocation = { runId, waitedMs: 0 };

      let hook: ParsedHook;
      try {
        hook = parseHookPayload(payload);
      } catch (err) {
        return appendError(call, null, 'parse', err);
      }
      try {
        return await dispatch(call, hook);
      } catch (err) {
        return appendError(call, hook.kind === 'unknown' ? hook.hookEventName : hook.kind, 'record', err);
      }
    },
  };
}
