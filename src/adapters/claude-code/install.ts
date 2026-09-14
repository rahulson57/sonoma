/**
 * installHooks(projectDir): configure Claude Code, through its documented hook settings only, to run
 * `ckpt hook <HookEventName>` for every hook the adapter maps (SPEC-009 "Must never: modify, patch, or require
 * cooperation from Claude Code beyond its documented hook configuration").
 *
 * Target: `<projectDir>/.claude/settings.local.json`, the per-user project settings Claude Code keeps out of git.
 * Writing the committed `.claude/settings.json` would change every collaborator's sessions (Q-026 default 5).
 *
 * - Idempotent: adapter entries (commands starting `ckpt hook `) are removed and re-added in a fixed form and order,
 *   so a second run produces an identical file (and skips the write).
 * - Preserving: every other setting, every other hook and every other matcher group is kept, in its order.
 * - A settings file that is not a JSON object, or whose `hooks` has an unexpected shape, is refused and left untouched.
 * - The write is atomic (temp file + rename) and keeps an existing file's mode.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject } from './hook-payload.js';
import { HOOK_COMMAND_PREFIX, HOOK_EVENTS, type HookEventName } from './types.js';

export const SETTINGS_FILE = path.join('.claude', 'settings.local.json');

/** Tool hooks match on tool name; `*` observes every tool. The other hooks are installed without a matcher. */
const TOOL_HOOKS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

export function hookCommand(event: HookEventName): string {
  return `${HOOK_COMMAND_PREFIX}${event}`;
}

export function isAdapterHook(entry: unknown): boolean {
  return isPlainObject(entry) && typeof entry['command'] === 'string' && entry['command'].startsWith(HOOK_COMMAND_PREFIX);
}

export class HookSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookSettingsError';
  }
}

/** A copy of `settings` with exactly one adapter hook entry per mapped hook. The input is not modified. */
export function withAdapterHooks(settings: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const current = settings['hooks'];
  if (current !== undefined && !isPlainObject(current)) throw new HookSettingsError('settings "hooks" must be an object');
  const hooks: Record<string, unknown> = { ...(current ?? {}) };

  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) throw new HookSettingsError(`settings "hooks.${event}" must be an array`);
    const kept: unknown[] = [];
    for (const group of (groups ?? []) as unknown[]) {
      if (!isPlainObject(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const entries = group['hooks'] as unknown[];
      const others = entries.filter((entry) => !isAdapterHook(entry));
      if (others.length === entries.length) kept.push(group);
      else if (others.length > 0) kept.push({ ...group, hooks: others });
    }
    kept.push({
      ...(TOOL_HOOKS.has(event) ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: hookCommand(event) }],
    });
    hooks[event] = kept;
  }
  return { ...settings, hooks };
}

export function renderSettings(settings: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

async function readSettings(file: string): Promise<{ text: string | null; settings: Record<string, unknown> }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, settings: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new HookSettingsError(`${file} is not valid JSON; hooks were not installed`);
  }
  if (!isPlainObject(parsed)) throw new HookSettingsError(`${file} must hold a JSON object; hooks were not installed`);
  return { text, settings: parsed };
}

export async function installHooks(projectDir: string): Promise<void> {
  if (typeof projectDir !== 'string' || projectDir === '') throw new TypeError('installHooks needs a project directory');
  const file = path.join(projectDir, SETTINGS_FILE);
  const { text, settings } = await readSettings(file);
  const next = renderSettings(withAdapterHooks(settings));
  if (next === text) return;

  await mkdir(path.dirname(file), { recursive: true });
  const mode = text === null ? 0o644 : (await stat(file)).mode & 0o777;
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, next, { mode, flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
