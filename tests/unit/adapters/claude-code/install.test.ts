/**
 * SPEC-009 criterion: installHooks is idempotent (running twice yields an identical settings file) and preserves
 * pre-existing user hooks. Everything happens in a directory under the OS temp dir (SPEC-001).
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, HookSettingsError, SETTINGS_FILE, installHooks } from '../../../../src/adapters/claude-code/index.js';

let projectDir: string;
const settingsPath = (): string => path.join(projectDir, SETTINGS_FILE);
const readSettings = async (): Promise<Record<string, any>> => JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, any>;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'ckpt-install-hooks-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function adapterCommands(settings: Record<string, any>, event: string): string[] {
  return ((settings['hooks']?.[event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>)
    .flatMap((group) => group.hooks ?? [])
    .map((hook) => hook.command ?? '')
    .filter((command) => command.startsWith('ckpt hook '));
}

describe('installHooks', () => {
  it('writes exactly one `ckpt hook <event>` command per mapped hook into .claude/settings.local.json', async () => {
    await installHooks(projectDir);
    expect(SETTINGS_FILE).toBe(path.join('.claude', 'settings.local.json'));
    const settings = await readSettings();
    expect(Object.keys(settings['hooks'])).toEqual([...HOOK_EVENTS]);
    for (const event of HOOK_EVENTS) expect(adapterCommands(settings, event)).toEqual([`ckpt hook ${event}`]);
    expect(settings['hooks']['PreToolUse']).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: 'ckpt hook PreToolUse' }] }]);
    expect(settings['hooks']['Stop']).toEqual([{ hooks: [{ type: 'command', command: 'ckpt hook Stop' }] }]);
    // The committed project settings are never written.
    await expect(stat(path.join(projectDir, '.claude', 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates the settings file when absent and never touches .gitignore', async () => {
    const gitignore = path.join(projectDir, '.gitignore');
    await writeFile(gitignore, 'node_modules/\n');
    await installHooks(projectDir);
    await installHooks(projectDir);
    expect(await readFile(gitignore, 'utf8')).toBe('node_modules/\n');
    await expect(stat(path.join(projectDir, '.claude', '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(settingsPath())).isFile()).toBe(true);
  });

  it('is idempotent: running twice yields an identical settings file', async () => {
    await installHooks(projectDir);
    const first = await readFile(settingsPath());
    await installHooks(projectDir);
    const second = await readFile(settingsPath());
    expect(second.equals(first)).toBe(true);
    for (const event of HOOK_EVENTS) expect(adapterCommands(await readSettings(), event)).toHaveLength(1);
  });

  it('preserves pre-existing user hooks, their order and every other setting, and stays idempotent', async () => {
    const userSettings = {
      permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'] },
      env: { NODE_ENV: 'development' },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.sh', timeout: 10 }] },
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx prettier --check' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send claude' }] }],
      },
      model: 'claude-opus-5',
    };
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), `${JSON.stringify(userSettings, null, 2)}\n`);

    await installHooks(projectDir);
    const once = await readFile(settingsPath());
    await installHooks(projectDir);
    expect((await readFile(settingsPath())).equals(once)).toBe(true);

    const settings = await readSettings();
    expect(Object.keys(settings)).toEqual(['permissions', 'env', 'hooks', 'model']);
    expect(settings['permissions']).toEqual(userSettings.permissions);
    expect(settings['env']).toEqual(userSettings.env);
    expect(settings['model']).toBe('claude-opus-5');
    expect(settings['hooks']['Notification']).toEqual(userSettings.hooks.Notification);
    expect(settings['hooks']['PreToolUse'].slice(0, 2)).toEqual(userSettings.hooks.PreToolUse);
    expect(settings['hooks']['Stop'][0]).toEqual(userSettings.hooks.Stop[0]);
    for (const event of HOOK_EVENTS) expect(adapterCommands(settings, event)).toEqual([`ckpt hook ${event}`]);
  });

  it('replaces a stale adapter entry instead of duplicating it, keeping user hooks in the same group', async () => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: './log-tool.sh' }, { type: 'command', command: 'ckpt hook PostToolUse --legacy' }] },
            { matcher: 'Write', hooks: [{ type: 'command', command: 'ckpt hook PostToolUse' }] },
          ],
        },
      }),
    );
    await installHooks(projectDir);
    const settings = await readSettings();
    expect(settings['hooks']['PostToolUse']).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: './log-tool.sh' }] },
      { matcher: '*', hooks: [{ type: 'command', command: 'ckpt hook PostToolUse' }] },
    ]);
  });

  it.each([
    ['text that is not JSON', '{"hooks": '],
    ['a JSON array', '[]'],
    ['hooks that are not an object', '{"hooks": []}'],
    ['a hook list that is not an array', '{"hooks": {"Stop": {"command": "say done"}}}'],
  ])('refuses a settings file with %s and leaves it untouched', async (_label, content) => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), content);
    await expect(installHooks(projectDir)).rejects.toBeInstanceOf(HookSettingsError);
    expect(await readFile(settingsPath(), 'utf8')).toBe(content);
  });

  it("keeps an existing settings file's permissions", async () => {
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), '{}\n', { mode: 0o600 });
    await installHooks(projectDir);
    expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
  });
});
