/**
 * Workspace status for workspace.changed: porcelain parsing, a digest that the engine's sanitize() leaves unchanged,
 * and the real `git status` reader against a throwaway repository (tests/helpers/tmpRepo.ts): it excludes the ckpt
 * store and never writes the index.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_STATUS_ENTRIES,
  WORKSPACE_STATUS_DIGEST_LENGTH,
  parsePorcelainZ,
  readWorkspaceStatus,
  statusDigest,
} from '../../../../src/adapters/claude-code/index.js';
import { sanitize } from '../../../../src/redact/index.js';
import { tmpGitRepo } from '../../../helpers/tmpRepo.js';

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('workspace status', () => {
  it('parses porcelain v1 -z, including renames and paths with spaces', () => {
    expect(parsePorcelainZ(bytes(' M src/app.ts\0?? notes/new file.md\0R  lib/new.ts\0lib/old.ts\0D  gone.txt\0'))).toEqual({
      entries: [
        { status: ' M', path: 'src/app.ts' },
        { status: '??', path: 'notes/new file.md' },
        { status: 'R ', path: 'lib/new.ts', oldPath: 'lib/old.ts' },
        { status: 'D ', path: 'gone.txt' },
      ],
      truncated: false,
    });
    expect(parsePorcelainZ(bytes(''))).toEqual({ entries: [], truncated: false });
  });

  it(`lists at most ${MAX_STATUS_ENTRIES} entries and marks the rest truncated`, () => {
    const porcelain = Array.from({ length: MAX_STATUS_ENTRIES + 5 }, (_, i) => `?? f${i}\0`).join('');
    const parsed = parsePorcelainZ(bytes(porcelain));
    expect(parsed.entries).toHaveLength(MAX_STATUS_ENTRIES);
    expect(parsed.truncated).toBe(true);
  });

  it('the digest is short hex that sanitize() leaves byte-identical, and differs when the status differs', () => {
    const inputs = ['', ' M a\0', '?? b\0', `?? ${'x'.repeat(5000)}\0`];
    const digests = inputs.map((input) => statusDigest(bytes(input)));
    for (const digest of digests) {
      expect(digest).toMatch(new RegExp(`^[0-9a-f]{${WORKSPACE_STATUS_DIGEST_LENGTH}}$`));
      expect(sanitize(digest).output).toBe(digest);
    }
    expect(new Set(digests).size).toBe(inputs.length);
    expect(statusDigest(bytes(' M a\0'))).toBe(digests[1]);
  });

  it('reads the real git status, ignores the .ckpt store, and never writes the index', async () => {
    const repo = await tmpGitRepo({ files: { 'README.md': '# app\n', 'src/app.ts': 'export {};\n' } });
    try {
      const index = path.join(repo.dir, '.git', 'index');
      const indexBefore = await readFile(index);
      const mtimeBefore = (await stat(index)).mtimeMs;

      const clean = await readWorkspaceStatus(repo.dir);
      expect(clean.entries).toEqual([]);

      await mkdir(path.join(repo.dir, '.ckpt', 'objects'), { recursive: true });
      await writeFile(path.join(repo.dir, '.ckpt', 'objects', 'blob'), 'store data');
      expect((await readWorkspaceStatus(repo.dir)).digest).toBe(clean.digest);

      await writeFile(path.join(repo.dir, 'src', 'app.ts'), 'export const changed = true;\n');
      await writeFile(path.join(repo.dir, 'new.txt'), 'hello\n');
      const dirty = await readWorkspaceStatus(repo.dir);
      expect(dirty.digest).not.toBe(clean.digest);
      expect(dirty.entries).toEqual([
        { status: ' M', path: 'src/app.ts' },
        { status: '??', path: 'new.txt' },
      ]);

      expect((await readFile(index)).equals(indexBefore)).toBe(true);
      expect((await stat(index)).mtimeMs).toBe(mtimeBefore);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects outside a git worktree (the handler records that as adapter.error)', async () => {
    const { tmpdir } = await import('node:os');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const dir = await mkdtemp(path.join(tmpdir(), 'ckpt-not-a-repo-'));
    try {
      await expect(readWorkspaceStatus(dir)).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
