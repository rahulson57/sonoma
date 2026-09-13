/**
 * Filesystem primitives with the SPEC-003/SPEC-005 permission rule baked in: every directory Local
 * Storage creates is 0700 and every file 0600. Modes are set explicitly with chmod after creation, so
 * the result does not depend on the process umask (which is global and cannot be changed from a
 * worker thread).
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** mkdir -p with mode 0700 on the leaf (and on any parent this call creates). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);
}

/** Make a directory entry change (create / rename) durable. Best effort where the OS refuses. */
export async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'EISDIR' && code !== 'EINVAL' && code !== 'EPERM' && code !== 'EBADF') throw err;
  } finally {
    await handle?.close();
  }
}

/** Create `file` (failing with EEXIST if present), mode 0600, write `data`, fsync. */
export async function writeExclusive(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(file, 'wx', FILE_MODE);
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close();
    await unlink(file).catch(() => undefined);
    throw err;
  }
  await handle.close();
}

/** Append `data` to `file` (created 0600 if missing) and fsync before returning. */
export async function appendDurable(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(file, 'a', FILE_MODE);
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write all of `bytes` at the handle's current position. */
export async function writeAll(handle: import('node:fs/promises').FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    offset += bytesWritten;
  }
}

/** Replace `file` atomically: 0600 temp file in the same directory, fsync, rename, fsync dir. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  await writeExclusive(tmp, data);
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fsyncDir(path.dirname(file));
}
