/**
 * The in-repo ustar writer/reader behind SPEC-011's `bundleFile`: a real tar, deterministic, and safe to
 * read from an untrusted bundle.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleFormatError, TarWriter, entryNameProblem, readTarEntry, readTarIndex } from '../../../src/bundle/tar.js';

const execFileAsync = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'ckpt-tar-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeArchive(file: string, entries: Array<[string, Uint8Array | string]>): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    const writer = new TarWriter(handle);
    for (const [name, data] of entries) await writer.add(name, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    await writer.finish();
  } finally {
    await handle.close();
  }
}

async function readArchive(file: string): Promise<Map<string, Buffer>> {
  const handle = await open(file, 'r');
  try {
    const out = new Map<string, Buffer>();
    for (const entry of await readTarIndex(handle)) out.set(entry.name, await readTarEntry(handle, entry));
    return out;
  } finally {
    await handle.close();
  }
}

/** Recompute a header's checksum after a test mutates it. */
function fixChecksum(archive: Buffer, headerOffset: number): void {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : archive[headerOffset + i]!;
  archive.write(sum.toString(8).padStart(6, '0'), headerOffset + 148, 6, 'ascii');
  archive[headerOffset + 154] = 0;
  archive[headerOffset + 155] = 0x20;
}

const LONG_NAME = `runs/${'d'.repeat(90)}/${'e'.repeat(60)}/events.jsonl`;

const SAMPLE: Array<[string, Uint8Array | string]> = [
  ['manifest.json', '{"schemaVersion":1}\n'],
  ['empty', ''],
  ['exact-block', Buffer.alloc(512, 0x61)],
  ['one-over-block', Buffer.alloc(513, 0x62)],
  ['binary', Buffer.from([0, 255, 1, 254, 0, 0, 10, 13])],
  [LONG_NAME, 'long name through the ustar prefix field\n'],
];

describe('TarWriter / readTarIndex', () => {
  it('round-trips every entry name and byte, including empty, block-aligned and prefix-split names', async () => {
    const file = path.join(dir, 'a.tar');
    await writeArchive(file, SAMPLE);
    const read = await readArchive(file);
    expect([...read.keys()]).toEqual(SAMPLE.map(([name]) => name));
    for (const [name, data] of SAMPLE) {
      expect(read.get(name)!.equals(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))).toBe(true);
    }
    expect((await readFile(file)).byteLength % 512).toBe(0);
  });

  it('is deterministic: the same entries give byte-identical archives', async () => {
    await writeArchive(path.join(dir, 'a.tar'), SAMPLE);
    await writeArchive(path.join(dir, 'b.tar'), SAMPLE);
    expect((await readFile(path.join(dir, 'a.tar'))).equals(await readFile(path.join(dir, 'b.tar')))).toBe(true);
  });

  it('writes a real tar that the system tar lists with the same names', async () => {
    const file = path.join(dir, 'a.tar');
    await writeArchive(file, SAMPLE);
    const { stdout } = await execFileAsync('tar', ['-tf', file]);
    expect(stdout.trim().split('\n')).toEqual(SAMPLE.map(([name]) => name));
  });

  it('refuses unsafe or duplicate names when writing', async () => {
    for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', './a', 'a\\b', 'sp ace', 'nul\0']) {
      expect(entryNameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    const handle = await open(path.join(dir, 'c.tar'), 'wx', 0o600);
    try {
      const writer = new TarWriter(handle);
      await expect(writer.add('../escape', Buffer.from('x'))).rejects.toBeInstanceOf(BundleFormatError);
      await writer.add('same', Buffer.from('1'));
      await expect(writer.add('same', Buffer.from('2'))).rejects.toThrow(/duplicate/);
    } finally {
      await handle.close();
    }
  });
});

describe('readTarIndex on untrusted input', () => {
  async function expectRejected(bytes: Buffer, pattern: RegExp): Promise<void> {
    const file = path.join(dir, `bad-${Math.random().toString(16).slice(2)}.tar`);
    await writeFile(file, bytes);
    await expect(readArchive(file)).rejects.toThrow(pattern);
  }

  async function sampleBytes(entries: Array<[string, Uint8Array | string]> = [['objects/x', 'hello']]): Promise<Buffer> {
    const file = path.join(dir, `src-${Math.random().toString(16).slice(2)}.tar`);
    await writeArchive(file, entries);
    return readFile(file);
  }

  it('rejects a header whose checksum does not match', async () => {
    const bytes = await sampleBytes();
    bytes[0] = 'p'.charCodeAt(0);
    await expectRejected(bytes, /checksum/);
  });

  it('rejects a "../" entry name even with a valid checksum', async () => {
    const bytes = await sampleBytes();
    bytes.fill(0, 0, 100);
    bytes.write('../../etc/passwd', 0, 'ascii');
    fixChecksum(bytes, 0);
    await expectRejected(bytes, /segments/);
  });

  it('rejects an absolute entry name', async () => {
    const bytes = await sampleBytes();
    bytes.fill(0, 0, 100);
    bytes.write('/tmp/x', 0, 'ascii');
    fixChecksum(bytes, 0);
    await expectRejected(bytes, /relative/);
  });

  it('rejects a symlink entry', async () => {
    const bytes = await sampleBytes();
    bytes[156] = '2'.charCodeAt(0);
    fixChecksum(bytes, 0);
    await expectRejected(bytes, /not a regular file/);
  });

  it('rejects duplicate entry names', async () => {
    const one = await sampleBytes();
    const withoutEnd = one.subarray(0, one.byteLength - 1024);
    await expectRejected(Buffer.concat([withoutEnd, one]), /duplicate/);
  });

  it('rejects an archive cut short (missing content or end-of-archive marker)', async () => {
    const bytes = await sampleBytes([['objects/big', Buffer.alloc(4000, 0x41)]]);
    await expectRejected(bytes.subarray(0, 2048), /truncated/);
    await expectRejected(bytes.subarray(0, bytes.byteLength - 1024), /truncated|end-of-archive/);
  });
});
