/** Claude Code Observation Adapter — public surface (SPEC-009). */
export {
  CLAUDE_CODE_AGENT,
  HOOK_COMMAND_PREFIX,
  HOOK_EVENTS,
  RUN_ID_ENV,
  SPEC_HOOK_EVENTS,
  WORKSPACE_TOOLS,
  type AdapterEngine,
  type AdapterLedgerReader,
  type EventId,
  type ExitCode,
  type HookEventName,
} from './types.js';
export { HookPayloadError, isErrorResponse, parseHookPayload, type ParsedHook } from './hook-payload.js';
export { HOOK_MAPPING, MAX_ERROR_TEXT, type HookMappingEntry, type Observation } from './mapping.js';
export { HookSettingsError, SETTINGS_FILE, hookCommand, installHooks, isAdapterHook, renderSettings, withAdapterHooks } from './install.js';
export {
  MAX_STATUS_ENTRIES,
  WORKSPACE_STATUS_DIGEST_LENGTH,
  parsePorcelainZ,
  readWorkspaceStatus,
  statusDigest,
  workspaceStatusOf,
  type ReadWorkspaceStatus,
  type StatusEntry,
  type WorkspaceStatus,
} from './workspace-status.js';
export {
  DEFAULT_LOCK_RETRY,
  LOCK_RETRY_DELAY_MS,
  MAX_LOCK_WAIT_MS,
  MAX_REQUEST_SCAN,
  boundRunId,
  createHookHandler,
  type HookHandler,
  type HookHandlerOptions,
  type LockRetryPolicy,
} from './handler.js';
export {
  EXIT_COMMAND_NOT_FOUND,
  FORWARDED_SIGNALS,
  IGNORED_SIGNALS,
  createRunner,
  type OpenedEngine,
  type Runner,
  type RunnerOptions,
  type SignalSource,
  type SpawnProcess,
} from './run.js';
