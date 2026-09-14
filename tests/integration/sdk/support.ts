/** Store byte scans for the State SDK integration tests (SPEC-010 / SPEC-003). Read-only. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bytesUnder, git, gitBytes } from '../engine/support.js';

/** Raw bytes of every git object reachable from refs/checkpoints/*. */
export async function checkpointObjects(repoDir: string): Promise<Buffer> {
  const refs = (await git(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/checkpoints'])).split('\n').filter((line) => line !== '');
  if (refs.length === 0) return Buffer.alloc(0);
  const ids = new Set(
    (await git(repoDir, ['rev-list', '--objects', ...refs]))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split(' ')[0]!),
  );
  const chunks: Buffer[] = [];
  for (const id of ids) {
    const type = (await git(repoDir, ['cat-file', '-t', id])).trim();
    chunks.push(await gitBytes(repoDir, ['cat-file', type, id]));
  }
  return Buffer.concat(chunks);
}

/** checkpoint.db with its WAL and shared-memory files. */
export async function checkpointDb(store: string): Promise<Buffer> {
  const parts = await Promise.all(
    ['checkpoint.db', 'checkpoint.db-wal', 'checkpoint.db-shm'].map((file) => readFile(path.join(store, file)).catch(() => Buffer.alloc(0))),
  );
  return Buffer.concat(parts);
}

/** CAS, SQLite, refs/checkpoints/* objects, and everything else under .ckpt/. */
export async function storeBytes(repoDir: string): Promise<Record<string, Buffer>> {
  const store = path.join(repoDir, '.ckpt');
  return {
    CAS: await bytesUnder(path.join(store, 'objects')),
    'checkpoint.db': await checkpointDb(store),
    'refs/checkpoints/*': await checkpointObjects(repoDir),
    '.ckpt/': await bytesUnder(store),
  };
}
