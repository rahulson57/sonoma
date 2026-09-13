/**
 * Content-addressed blob store: `objects/sha256/<first 2 hex>/<sha256>` (SPEC-005).
 *
 * - The address is the sha256 of the bytes, so identical bytes are stored exactly once (dedup).
 * - Writes go to a 0600 temp file in `.ckpt/tmp`, are fsynced, then renamed into place, so a blob path
 *   either does not exist or holds the complete bytes. A blob whose size does not match its address
 *   (e.g. a damaged file) is replaced by the next put of the correct bytes.
 * - Reads are verified: `get` errors with ERR_CORRUPT if the bytes do not hash to the requested ref.
 *
 * Callers are responsible for sanitizing bytes before they get here (SPEC-003).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import type { BlobRef } from '../model/types.js';
import { StorageError } from './errors.js';
import { FILE_MODE, ensureDir, errnoCode, fsyncDir, writeAll, writeExclusive } from './fs-util.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function assertBlobRef(ref: unknown): asserts ref is BlobRef {
  const candidate = ref as Partial<BlobRef> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.sha256 !== 'string' ||
    !SHA256_HEX.test(candidate.sha256) ||
    typeof candidate.size !== 'number' ||
    !Number.isInteger(candidate.size) ||
    candidate.size < 0
  ) {
    throw new StorageError('ERR_INVALID_INPUT', `not a BlobRef {sha256, size}: ${JSON.stringify(ref)}`);
  }
}

export class BlobStore {
  readonly objectsDir: string;
  readonly tmpDir: string;

  constructor(objectsDir: string, tmpDir: string) {
    this.objectsDir = objectsDir;
    this.tmpDir = tmpDir;
  }

  pathFor(sha256: string): string {
    if (!SHA256_HEX.test(sha256)) throw new StorageError('ERR_INVALID_INPUT', `not a sha256: ${JSON.stringify(sha256)}`);
    return path.join(this.objectsDir, sha256.slice(0, 2), sha256);
  }

  async put(data: Uint8Array | Readable): Promise<BlobRef> {
    if (data instanceof Uint8Array) {
      const ref: BlobRef = { sha256: createHash('sha256').update(data).digest('hex'), size: data.byteLength };
      if (await this.has(ref)) return ref;
      const tmp = this.#tmpPath();
      await writeExclusive(tmp, data);
      return this.#install(tmp, ref);
    }
    if (!(data instanceof Readable)) {
      throw new StorageError('ERR_INVALID_INPUT', 'putBlob accepts a Uint8Array or a Readable');
    }

    const tmp = this.#tmpPath();
    const handle = await open(tmp, 'wx', FILE_MODE);
    const hash = createHash('sha256');
    let size = 0;
    try {
      await handle.chmod(FILE_MODE);
      for await (const chunk of data) {
        const bytes: Uint8Array = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Uint8Array);
        hash.update(bytes);
        size += bytes.byteLength;
        await writeAll(handle, bytes);
      }
      await handle.sync();
    } catch (err) {
      await handle.close();
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    await handle.close();
    return this.#install(tmp, { sha256: hash.digest('hex'), size });
  }

  /** True when a blob with this address and size is present. */
  async has(ref: BlobRef): Promise<boolean> {
    assertBlobRef(ref);
    try {
      const st = await stat(this.pathFor(ref.sha256));
      return st.isFile() && st.size === ref.size;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    }
  }

  /** A stream of the blob's bytes that errors with ERR_CORRUPT if they do not match `ref`. */
  async get(ref: BlobRef): Promise<Readable> {
    assertBlobRef(ref);
    const file = this.pathFor(ref.sha256);
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') throw new StorageError('ERR_NOT_FOUND', `blob ${ref.sha256} is not in the store`);
      throw err;
    }
    if (size !== ref.size) {
      throw new StorageError('ERR_CORRUPT', `blob ${ref.sha256} has ${size} bytes, expected ${ref.size}`);
    }

    const hash = createHash('sha256');
    let seen = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        seen += chunk.byteLength;
        callback(null, chunk);
      },
      flush(callback) {
        const digest = hash.digest('hex');
        if (digest !== ref.sha256 || seen !== ref.size) {
          callback(new StorageError('ERR_CORRUPT', `blob ${ref.sha256} content hashes to ${digest}`));
        } else {
          callback();
        }
      },
    });
    pipeline(createReadStream(file), verify, () => undefined);
    return verify;
  }

  /** Read a whole blob into memory (verified). */
  async read(ref: BlobRef): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.get(ref)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** Every blob present on disk, by address (sizes from stat; content not re-hashed). */
  async list(): Promise<BlobRef[]> {
    const refs: BlobRef[] = [];
    let fanout: string[];
    try {
      fanout = await readdir(this.objectsDir);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return refs;
      throw err;
    }
    for (const prefix of fanout.sort()) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const name of (await readdir(path.join(this.objectsDir, prefix))).sort()) {
        if (!SHA256_HEX.test(name) || !name.startsWith(prefix)) continue;
        const st = await stat(path.join(this.objectsDir, prefix, name));
        if (st.isFile()) refs.push({ sha256: name, size: st.size });
      }
    }
    return refs;
  }

  async #install(tmp: string, ref: BlobRef): Promise<BlobRef> {
    try {
      if (await this.has(ref)) {
        await unlink(tmp);
        return ref;
      }
      const final = this.pathFor(ref.sha256);
      await ensureDir(path.dirname(final));
      await rename(tmp, final);
      await fsyncDir(path.dirname(final));
      return ref;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  #tmpPath(): string {
    return path.join(this.tmpDir, `blob-${randomBytes(8).toString('hex')}.tmp`);
  }
}
