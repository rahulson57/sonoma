/**
 * Claude Code Observation Adapter contract types (SPEC-009).
 *
 * The adapter observes an unmodified Claude Code session through its documented hooks and turns each hook
 * invocation into canonical ledger observations for the Checkpoint Engine's `record()`. It owns no state model,
 * store or file of its own: the only thing it writes directly is the hook configuration `installHooks` puts into
 * Claude Code's settings, and everything it observes goes through the engine (which sanitizes before persisting).
 */
import type { CheckpointEngine } from '../../engine/index.js';
import type { StorageBackend } from '../../storage/types.js';

/** A ledger event id (`LedgerEvent.event_id`). */
export type EventId = string;

/** A process exit code. */
export type ExitCode = number;

/** `Run.agent` for runs started by `ckpt run claude`. */
export const CLAUDE_CODE_AGENT = 'claude-code';

/**
 * Environment variable that binds a hook invocation to its run. `run()` sets it on the `claude` process, and Claude
 * Code hands its environment to every hook command it spawns. It is the only channel a separate hook process has to
 * its run, since the adapter may not keep a store of its own.
 */
export const RUN_ID_ENV = 'CKPT_RUN_ID';

/** Hook entries the adapter installs run `ckpt hook <HookEventName>`; this prefix is how they are recognised. */
export const HOOK_COMMAND_PREFIX = 'ckpt hook ';

/** The six hooks SPEC-009 names. */
export const SPEC_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const;

/**
 * Every hook the adapter installs and maps: SPEC-009's six plus `PostToolUseFailure`, which current Claude Code
 * fires INSTEAD of PostToolUse when a tool fails (Q-026 default 2, challenge 01a09e3c on SPEC-009).
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Tools whose PostToolUse also checks `git status` for a `workspace.changed` observation (SPEC-009 mapping table). */
export const WORKSPACE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'Bash']);

/** What the hook handler needs from the Checkpoint Engine. */
export type AdapterEngine = Pick<CheckpointEngine, 'record' | 'checkpoint' | 'workspaceDir'>;

/** Read-only ledger access, used only to correlate a PostToolUse with its PreToolUse and to find run.created. */
export type AdapterLedgerReader = Pick<StorageBackend, 'getEvents' | 'getBlob'>;
