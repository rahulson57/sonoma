/**
 * DEC-044(4) / SPEC-009 "Must never: write to refs/heads/* or the user's branch": observing Write/Edit/Bash reads git
 * status with --no-optional-locks, so the user's .git/index is never refreshed. After real Pre/PostToolUse pairs on
 * those tools, through the real engine, .git/index and every refs/heads/* ref (loose and packed), HEAD and ORIG_HEAD
 * are byte-identical.
 *
 * Before each pair the index is made STAT-DIRTY BUT CONTENT-CLEAN: a tracked file is rewritten with its own bytes and
 * given a different mtime. A plain `git status` (optional locks on) refreshes that entry and rewrites .git/index. A
 * content change alone would not prove anything: git leaves the entry of a modified file as it is, so detection would
 * depend on racy-git timing. The control case runs a plain `git status` on this same setup and asserts that it DOES
 * rewrite .git/index, so a status without --no-optional-locks makes every pair fail.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { STORE_DIR_NAME } from '../../../../src/storage/layout.js';
import { allEvents, git, writeFiles } from '../../engine/support.js';
import { adapterFixture, hookInput } from './support.js';

const execFileAsync = promisify(execFile);

const FILES = { 'README.md': '# app\n', 'src/app.ts': 'export const v = 1;\n' };

async function readOptional(file: string): Promise<Buffer | null> {
  return readFile(file).catch(() => null);
}

async function looseRefs(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, await looseRefs(path.join(dir, entry.name), `${rel}/`));
    else out[rel] = await readFile(path.join(dir, entry.name), 'utf8');
  }
  return out;
}

async function userRepoState(repoDir: string) {
  const gitDir = path.join(repoDir, '.git');
  return {
    index: await readOptional(path.join(gitDir, 'index')),
    heads: await looseRefs(path.join(gitDir, 'refs', 'heads')),
    packedRefs: await readOptional(path.join(gitDir, 'packed-refs')),
    HEAD: await readOptional(path.join(gitDir, 'HEAD')),
    ORIG_HEAD: await readOptional(path.join(gitDir, 'ORIG_HEAD')),
    forEachRefHeads: await git(repoDir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
  };
}

/**
 * The user's repository as a session finds it:
 * - README.md is stat-dirty but content-clean (same bytes, different mtime): a refreshing `git status` rewrites the
 *   index for it;
 * - src/app.ts already carries uncommitted work (v = 2), which the Edit case builds on.
 */
async function prepareUserRepo(repoDir: string): Promise<void> {
  const readme = path.join(repoDir, 'README.md');
  await writeFile(readme, await readFile(readme));
  const earlier = new Date(Date.now() - 60_000);
  await utimes(readme, earlier, earlier);
  await writeFiles(repoDir, { 'src/app.ts': 'export const v = 2;\n' });
}

/** The adapter's status command WITHOUT --no-optional-locks, and with optional locks left on. */
async function plainGitStatus(repoDir: string): Promise<void> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.', `:(exclude)${STORE_DIR_NAME}`], {
    cwd: repoDir,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/**
 * Each case: the file the tool writes, and whether `git status` text differs afterwards. Bash and Write create a new
 * file, so the status gains an entry. Edit rewrites the file that is ALREADY modified: its status line stays ` M`, so
 * SPEC-009's "git status differs" rule records no workspace.changed. That is pinned here as the rule's known limit, and
 * the next checkpoint still snapshots the edit.
 */
const CASES = [
  { tool: 'Bash', input: { command: 'echo hi > out.txt' }, writes: { 'out.txt': 'hi\n' }, changed: true },
  { tool: 'Write', input: { file_path: 'notes/new.md', content: '# notes\n' }, writes: { 'notes/new.md': '# notes\n' }, changed: true },
  { tool: 'Edit', input: { file_path: 'src/app.ts', old_string: '2', new_string: '3' }, writes: { 'src/app.ts': 'export const v = 3;\n' }, changed: false },
] as const;

describe("observing tool calls never writes the user's index or branches", () => {
  it('control: on this setup a plain git status (optional locks on) DOES rewrite .git/index', async () => {
    const fx = await adapterFixture(FILES);
    try {
      await prepareUserRepo(fx.repo.dir);
      const index = path.join(fx.repo.dir, '.git', 'index');
      const before = await readFile(index);
      await plainGitStatus(fx.repo.dir);
      expect((await readFile(index)).equals(before)).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  it.each(CASES)('$tool Pre/PostToolUse leaves .git/index and refs/heads/* byte-identical', async ({ tool, input, writes, changed }) => {
    const fx = await adapterFixture(FILES);
    try {
      await prepareUserRepo(fx.repo.dir);

      const before = await userRepoState(fx.repo.dir);
      expect(before.index).not.toBeNull();
      expect(Object.keys(before.heads).length + (before.packedRefs === null ? 0 : 1)).toBeGreaterThan(0);

      const id = `toolu_01Untouched${tool}AaBbCcDdEe`;
      await fx.handler.handleHook(hookInput('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id }));
      await writeFiles(fx.repo.dir, { ...writes });
      await fx.handler.handleHook(hookInput('PostToolUse', { tool_name: tool, tool_input: input, tool_response: { stdout: '' }, tool_use_id: id }));

      const types = (await allEvents(fx.backend, fx.run.run_id)).map((event) => event.type);
      expect(types).toEqual(['run.created', 'tool.requested', 'tool.completed', ...(changed ? ['workspace.changed'] : [])]);
      expect(await userRepoState(fx.repo.dir)).toEqual(before);
    } finally {
      await fx.cleanup();
    }
  });
});
