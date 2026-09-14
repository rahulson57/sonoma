/**
 * Parsing Claude Code hook input (the JSON document a hook command receives on stdin).
 *
 * Fields follow Claude Code's hooks reference: every hook carries `hook_event_name`; tool hooks carry `tool_name`,
 * `tool_input` and `tool_use_id`; PostToolUse carries `tool_response`; PostToolUseFailure carries `error` and
 * `is_interrupt`; SessionStart carries `source` (and sometimes `model`); UserPromptSubmit carries `prompt`; Stop
 * carries `stop_hook_active`; SessionEnd carries `reason`.
 *
 * Two failure classes are kept apart, because SPEC-009 records them differently:
 * - MALFORMED (not JSON, not an object, no string `hook_event_name`, or a known hook missing a field it cannot do
 *   without) throws HookPayloadError, recorded as `adapter.error`;
 * - UNKNOWN (a well-formed payload whose hook name the adapter does not map) parses to `{kind: 'unknown'}`, recorded
 *   as `adapter.unknown_hook`.
 * Parsing never copies or transforms tool data: inputs and responses are passed on exactly as received, for the
 * engine to sanitize.
 */
import { HOOK_EVENTS, type HookEventName } from './types.js';

export class HookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookPayloadError';
  }
}

export type ParsedHook =
  | { readonly kind: 'SessionStart'; readonly source: string | null; readonly model: string | null }
  | { readonly kind: 'UserPromptSubmit'; readonly prompt: string; readonly permissionMode: string | null }
  | { readonly kind: 'PreToolUse'; readonly tool: string; readonly toolUseId: string | null; readonly input: unknown }
  | {
      readonly kind: 'PostToolUse';
      readonly tool: string;
      readonly toolUseId: string | null;
      readonly input: unknown;
      readonly response: unknown;
    }
  | {
      readonly kind: 'PostToolUseFailure';
      readonly tool: string;
      readonly toolUseId: string | null;
      readonly error: unknown;
      readonly isInterrupt: boolean | null;
    }
  | { readonly kind: 'Stop'; readonly stopHookActive: boolean | null }
  | { readonly kind: 'SessionEnd'; readonly reason: string | null }
  | { readonly kind: 'unknown'; readonly hookEventName: string; readonly fields: readonly string[] };

const KNOWN_HOOKS: ReadonlySet<string> = new Set(HOOK_EVENTS);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function requiredString(doc: Record<string, unknown>, field: string, hook: string): string {
  const value = doc[field];
  if (typeof value !== 'string' || value === '') {
    throw new HookPayloadError(`${hook} payload needs a non-empty string ${field}`);
  }
  return value;
}

/** `undefined` (absent) becomes null so the observation stays valid JSON. */
function present(value: unknown): unknown {
  return value === undefined ? null : value;
}

function toDocument(input: unknown): Record<string, unknown> {
  let value = input;
  if (input instanceof Uint8Array) value = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8');
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new HookPayloadError('hook payload is not valid JSON');
    }
  }
  if (!isPlainObject(value)) throw new HookPayloadError('hook payload must be a JSON object');
  return value;
}

/** Parse one hook invocation's input: a JSON string, its UTF-8 bytes, or an already-parsed object. */
export function parseHookPayload(input: unknown): ParsedHook {
  const doc = toDocument(input);
  const name = doc['hook_event_name'];
  if (typeof name !== 'string' || name === '') throw new HookPayloadError('hook payload needs a string hook_event_name');
  if (!KNOWN_HOOKS.has(name)) return { kind: 'unknown', hookEventName: name, fields: Object.keys(doc).sort() };

  switch (name as HookEventName) {
    case 'SessionStart':
      return { kind: 'SessionStart', source: optionalString(doc['source']), model: optionalString(doc['model']) };
    case 'UserPromptSubmit':
      return {
        kind: 'UserPromptSubmit',
        prompt: typeof doc['prompt'] === 'string' ? doc['prompt'] : requiredString(doc, 'prompt', name),
        permissionMode: optionalString(doc['permission_mode']),
      };
    case 'PreToolUse':
      return {
        kind: 'PreToolUse',
        tool: requiredString(doc, 'tool_name', name),
        toolUseId: optionalString(doc['tool_use_id']),
        input: present(doc['tool_input']),
      };
    case 'PostToolUse':
      return {
        kind: 'PostToolUse',
        tool: requiredString(doc, 'tool_name', name),
        toolUseId: optionalString(doc['tool_use_id']),
        input: present(doc['tool_input']),
        response: present(doc['tool_response']),
      };
    case 'PostToolUseFailure':
      return {
        kind: 'PostToolUseFailure',
        tool: requiredString(doc, 'tool_name', name),
        toolUseId: optionalString(doc['tool_use_id']),
        error: present(doc['error']),
        isInterrupt: optionalBoolean(doc['is_interrupt']),
      };
    case 'Stop':
      return { kind: 'Stop', stopHookActive: optionalBoolean(doc['stop_hook_active']) };
    case 'SessionEnd':
      return { kind: 'SessionEnd', reason: optionalString(doc['reason']) };
  }
}

/**
 * True when a PostToolUse `tool_response` reports an error (older clients report failures there, before
 * PostToolUseFailure existed): an object with `is_error: true` or a non-empty string `error`.
 */
export function isErrorResponse(response: unknown): boolean {
  if (!isPlainObject(response)) return false;
  if (response['is_error'] === true) return true;
  const error = response['error'];
  return typeof error === 'string' && error !== '';
}
