/**
 * DEC-044(4) / SPEC-009 "Must never: write to refs/heads/* or the user's branch": observing Write/Edit/Bash reads git
 * status with --no-optional-locks, so the user's .git/index is never refreshed. After real Pre/PostToolUse pairs on
 * those tools, through the real engine, .git/index and every refs/heads/* ref (loose and packed), HEAD and ORIG_HEAD
 * are byte-identical.
 *
 * The tracked file is rewritten with SAME-SIZE content before the pair, so the index entry is stat-dirty: a plain
 * `git status` would rewrite .git/index to refresh it, and this test would catch that.
 */
import { readFile, readdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { allEvents, git, writeFiles } from '../../engine/support.js';
import { adapterFixture, hookInput } from './support.js';

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
  it.each(CASES)('$tool Pre/PostToolUse leaves .git/index and refs/heads/* byte-identical', async ({ tool, input, writes, changed }) => {
    const fx = await adapterFixture({ 'README.md': '# app\n', 'src/app.ts': 'export const v = 1;\n' });
    try {
      // Same size, different bytes, and a later mtime: the cached index entry no longer matches the file's stat data.
      await writeFiles(fx.repo.dir, { 'src/app.ts': 'export const v = 2;\n' });
      const later = new Date(Date.now() + 5_000);
      await utimes(path.join(fx.repo.dir, 'src', 'app.ts'), later, later);

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
