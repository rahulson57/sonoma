/**
 * DEC-019(2): every path handed to git is byte-exact. git reads `hash-object --stdin-paths` lines with
 * C-unquoting (a line that starts with `"`) and strips a trailing CR, so `"x"` must not commit x's bytes,
 * `y\r` must not commit y's, and a lone `"only"` must not fail.
 */
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Git-backed storage tests spawn many git processes; vitest's 5 s defaults fail on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { tmpGitRepo } from '../../helpers/tmpRepo.js';
import { NO_USAGE, checkpointFiles, git, makeTempDir, openBackend, treeFiles, writeFiles } from './support.js';

/** Asserts `commit` holds exactly `expected`, reading each blob with `git cat-file blob <commit>:<path>`. */
async function expectCommitted(repoDir: string, commit: string, expected: Record<string, string>): Promise<void> {
  expect([...(await treeFiles(repoDir, commit)).keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [rel, content] of Object.entries(expected)) {
    expect(await git(repoDir, ['cat-file', 'blob', `${commit}:${rel}`]), JSON.stringify(rel)).toBe(content);
  }
}

const TRICKY: Record<string, string> = {
  '"x"': 'QUOTED',
  x: 'PLAIN',
  'y\r': 'CR',
  y: 'NOCR',
  '"z': 'LEADING QUOTE, NO SIBLING',
  'dir "q"/back\\slash': 'BACKSLASH',
  'tab\there': 'TAB',
  'new\nline': 'NEWLINE',
  'ünïcødé ✓.txt': 'UNICODE',
  ' leading space': 'SPACE',
};

describe('checkpoint commits store staged bytes under their exact paths', () => {
  it('"x" next to x and y\\r next to y commit their own bytes, in full and incremental builds', async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-paths-');
    const { backend, clock } = await openBackend(repo.dir);
    try {
      const run = await backend.createRun({ agent: 'claude-code' });
      await writeFiles(staging.dir, TRICKY);
      const first = await backend.createCheckpoint({
        run_id: run.run_id,
        parent_checkpoint_id: null,
        pending_intent: [],
        usage: NO_USAGE,
        stagingDir: staging.dir,
      });
      await expectCommitted(repo.dir, first.workspace_commit, TRICKY);

      await writeFile(path.join(staging.dir, '"x"'), 'QUOTED 2');
      await writeFile(path.join(staging.dir, 'y\r'), 'CR 2');
      await writeFile(path.join(staging.dir, '"new"\r'), 'QUOTED AND CR');
      await rm(path.join(staging.dir, 'x'));
      await rm(path.join(staging.dir, 'new\nline'));
      clock.tick(1000);
      const second = await backend.createCheckpoint({
        run_id: run.run_id,
        parent_checkpoint_id: first.checkpoint_id,
        pending_intent: [],
        usage: NO_USAGE,
        stagingDir: staging.dir,
        changes: { written: ['"x"', 'y\r', '"new"\r'], deleted: ['x', 'new\nline'] },
      });
      const { x: _plain, 'new\nline': _newline, ...kept } = TRICKY;
      await expectCommitted(repo.dir, second.workspace_commit, { ...kept, '"x"': 'QUOTED 2', 'y\r': 'CR 2', '"new"\r': 'QUOTED AND CR' });
    } finally {
      await backend.close();
      await staging.cleanup();
      await repo.cleanup();
    }
  });

  it('a staged path git refuses fails the checkpoint instead of being silently dropped', async () => {
    const repo = await tmpGitRepo();
    const staging = await makeTempDir('ckpt-paths-');
    const { backend, clock } = await openBackend(repo.dir);
    // git's verify_path refuses ".git" in any case everywhere, and with core.protectHFS also ".git" spelled
    // with HFS-ignorable code points. update-index only prints "Ignoring path" for such an entry and exits 0.
    const hfsDotGit = '.g\u200cit/config'; // ZERO WIDTH NON-JOINER inside ".git"
    try {
      await git(repo.dir, ['config', 'core.protectHFS', 'true']);
      const run = await backend.createRun({ agent: 'claude-code' });
      const committed = async () => ({
        checkpoints: await backend.listCheckpoints(run.run_id),
        refs: await git(repo.dir, ['for-each-ref', 'refs/checkpoints/']),
      });
      // Full builds: a case variant of .git is refused before hashing; the HFS spelling by git itself.
      for (const refused of ['.GIT/config', 'sub/.Git/HEAD', hfsDotGit]) {
        await expect(
          checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: null }, { [refused]: 'NOT COMMITTED', 'ok.txt': 'ok' }),
          JSON.stringify(refused),
        ).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' });
      }
      expect(await committed()).toEqual({ checkpoints: [], refs: '' });

      await writeFiles(staging.dir, { 'ok.txt': 'ok' });
      const first = await backend.createCheckpoint({ run_id: run.run_id, parent_checkpoint_id: null, pending_intent: [], usage: NO_USAGE, stagingDir: staging.dir });
      await expectCommitted(repo.dir, first.workspace_commit, { 'ok.txt': 'ok' });
      const before = await committed();

      // Incremental builds fail the same paths with ERR_INVALID_CHANGES.
      await writeFiles(staging.dir, { '.GIT/config': 'NOT COMMITTED', [hfsDotGit]: 'NOT COMMITTED' });
      clock.tick(1000);
      for (const refused of ['.GIT/config', hfsDotGit]) {
        await expect(
          backend.createCheckpoint({
            run_id: run.run_id,
            parent_checkpoint_id: first.checkpoint_id,
            pending_intent: [],
            usage: NO_USAGE,
            stagingDir: staging.dir,
            changes: { written: ['ok.txt', refused], deleted: [] },
          }),
          JSON.stringify(refused),
        ).rejects.toMatchObject({ code: 'ERR_INVALID_CHANGES' });
      }
      expect(await committed()).toEqual(before);
    } finally {
      await backend.close();
      await staging.cleanup();
      await repo.cleanup();
    }
  });

  it('a staging tree holding only "only" checkpoints its bytes', async () => {
    const repo = await tmpGitRepo();
    const { backend } = await openBackend(repo.dir);
    try {
      const run = await backend.createRun({ agent: 'claude-code' });
      const checkpoint = await checkpointFiles(backend, { run_id: run.run_id, parent_checkpoint_id: null }, { '"only"': 'ONLY' });
      await expectCommitted(repo.dir, checkpoint.workspace_commit, { '"only"': 'ONLY' });
    } finally {
      await backend.close();
      await repo.cleanup();
    }
  });
});
