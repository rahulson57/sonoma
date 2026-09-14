/**
 * HookMapping (the data the Claude Code Adapter owns, architecture MOD-008): which ledger event each hook becomes,
 * and the observation payloads.
 *
 * | Hook                          | Ledger event                                         | Boundary |
 * |-------------------------------|------------------------------------------------------|----------|
 * | SessionStart                  | run.created (first) · agent.started (subsequent)     | no       |
 * | UserPromptSubmit              | model.requested                                      | no       |
 * | PreToolUse                    | tool.requested                                       | no       |
 * | PostToolUse (success)         | tool.completed (+ workspace.changed, Write/Edit/Bash)| no       |
 * | PostToolUse (error response)  | tool.failed                                          | no       |
 * | PostToolUseFailure            | tool.failed                                          | no       |
 * | Stop                          | agent.suspended                                      | yes      |
 * | SessionEnd                    | agent.suspended                                      | yes      |
 *
 * Deviations from the SPEC-009 table, pending challenge 01a09e3c (Q-026 defaults 1 and 2):
 * - run.created and agent.resumed are engine-owned (record() rejects them). run.created is the event `run()`'s
 *   startRun() emits, so the first SessionStart resolves to it and appends nothing. A subsequent SessionStart is
 *   `agent.started`, because engine.resume() would move the run into an execution worktree Claude is not using.
 * - PostToolUseFailure is mapped, since current Claude Code reports tool failures only through it.
 *
 * Observed only (SPEC-009): payload members are hook metadata and the tool data exactly as Claude Code reported it.
 * No builder derives or names a semantic field (goal, plan, decision(s), assumption(s), next_action, ...), and
 * Stop's `last_assistant_message` is deliberately not recorded.
 * Nothing here sanitizes: payloads go to the engine raw, and its Redaction pass runs before anything persists.
 */
import type { LedgerActor, LedgerEventType } from '../../model/types.js';
import type { HookEventName } from './types.js';
import type { ParsedHook } from './hook-payload.js';
import type { WorkspaceStatus } from './workspace-status.js';

export interface HookMappingEntry {
  /** Ledger event types this hook can produce, primary first. */
  readonly types: readonly LedgerEventType[];
  /** Whether the hook is a checkpoint boundary (an automatic, unlabelled checkpoint). */
  readonly boundary: boolean;
}

export const HOOK_MAPPING: Readonly<Record<HookEventName, HookMappingEntry>> = Object.freeze({
  SessionStart: { types: ['run.created', 'agent.started'], boundary: false },
  UserPromptSubmit: { types: ['model.requested'], boundary: false },
  PreToolUse: { types: ['tool.requested'], boundary: false },
  PostToolUse: { types: ['tool.completed', 'workspace.changed', 'tool.failed'], boundary: false },
  PostToolUseFailure: { types: ['tool.failed'], boundary: false },
  Stop: { types: ['agent.suspended'], boundary: true },
  SessionEnd: { types: ['agent.suspended'], boundary: true },
});

/** An observation before it is bound to a run. */
export interface Observation {
  readonly type: LedgerEventType;
  readonly actor: LedgerActor;
  /** Claude Code's tool_use_id, top-level and hashed (SPEC-015 amendment 2). Omitted when the hook has none. */
  readonly intent_id?: string;
  readonly payload: Record<string, unknown>;
}

type Hook<K extends ParsedHook['kind']> = Extract<ParsedHook, { kind: K }>;

function withIntent(toolUseId: string | null): { intent_id?: string } {
  return toolUseId === null ? {} : { intent_id: toolUseId };
}

export function sessionStarted(hook: Hook<'SessionStart'>): Observation {
  return { type: 'agent.started', actor: 'runtime', payload: { hook: hook.kind, source: hook.source, model: hook.model } };
}

export function promptSubmitted(hook: Hook<'UserPromptSubmit'>): Observation {
  return {
    type: 'model.requested',
    actor: 'human',
    payload: { hook: hook.kind, prompt: hook.prompt, permission_mode: hook.permissionMode },
  };
}

/** `workspaceStatus`: the git-status digest before a Write/Edit/Bash runs (null for other tools or when unreadable). */
export function toolRequested(hook: Hook<'PreToolUse'>, workspaceStatus: string | null): Observation {
  return {
    type: 'tool.requested',
    actor: 'agent',
    ...withIntent(hook.toolUseId),
    payload: {
      hook: hook.kind,
      tool_call_id: hook.toolUseId,
      tool: hook.tool,
      input: hook.input,
      ...(workspaceStatus === null ? {} : { workspace_status: workspaceStatus }),
    },
  };
}

export function toolCompleted(hook: Hook<'PostToolUse'>): Observation {
  return {
    type: 'tool.completed',
    actor: 'runtime',
    ...withIntent(hook.toolUseId),
    payload: { hook: hook.kind, tool_call_id: hook.toolUseId, tool: hook.tool, response: hook.response },
  };
}

/** A PostToolUse whose tool_response reports an error. */
export function toolFailedResponse(hook: Hook<'PostToolUse'>): Observation {
  return {
    type: 'tool.failed',
    actor: 'runtime',
    ...withIntent(hook.toolUseId),
    payload: { hook: hook.kind, tool_call_id: hook.toolUseId, tool: hook.tool, response: hook.response },
  };
}

export function toolFailed(hook: Hook<'PostToolUseFailure'>): Observation {
  return {
    type: 'tool.failed',
    actor: 'runtime',
    ...withIntent(hook.toolUseId),
    payload: { hook: hook.kind, tool_call_id: hook.toolUseId, tool: hook.tool, error: hook.error, is_interrupt: hook.isInterrupt },
  };
}

export function workspaceChanged(
  hook: Hook<'PostToolUse'>,
  before: string,
  after: WorkspaceStatus,
): Observation {
  return {
    type: 'workspace.changed',
    actor: 'runtime',
    ...withIntent(hook.toolUseId),
    payload: {
      hook: hook.kind,
      tool_call_id: hook.toolUseId,
      tool: hook.tool,
      workspace_status_before: before,
      workspace_status_after: after.digest,
      entries: after.entries.map((entry) => ({ ...entry })),
      truncated: after.truncated,
    },
  };
}

export function agentSuspended(hook: Hook<'Stop'> | Hook<'SessionEnd'>): Observation {
  return hook.kind === 'Stop'
    ? { type: 'agent.suspended', actor: 'agent', payload: { hook: hook.kind, stop_hook_active: hook.stopHookActive } }
    : { type: 'agent.suspended', actor: 'runtime', payload: { hook: hook.kind, reason: hook.reason } };
}

export function unknownHook(hook: Hook<'unknown'>): Observation {
  return { type: 'adapter.unknown_hook', actor: 'runtime', payload: { hook_event_name: hook.hookEventName, fields: [...hook.fields] } };
}

/** Longest error text an adapter.error carries. */
export const MAX_ERROR_TEXT = 4096;

/** `stage`: where handling failed (`parse`, `record`, `workspace_status`, `checkpoint`). */
export function adapterError(hook: string | null, stage: string, err: unknown): Observation {
  return { type: 'adapter.error', actor: 'runtime', payload: { hook, stage, error: describeError(err) } };
}

export function describeError(err: unknown): string {
  let text: string;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    text = `${typeof code === 'string' ? code : err.name}: ${err.message}`;
  } else {
    text = String(err);
  }
  return text.length > MAX_ERROR_TEXT ? text.slice(0, MAX_ERROR_TEXT) : text;
}
