/**
 * Shared fixtures for the Export/Import tests (SPEC-011). Every store is a real Local Storage store
 * (S04 LocalBackend) in a tmpGitRepo(); time comes from tests/helpers/clock.ts. No stand-in engine: runs
 * are built with createRun / appendEvent / createCheckpoint / putBlob.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createBundleService, type BundleService, type ExportIo } from '../../../src/bundle/index.js';
import type { BundleManifest } from '../../../src/bundle/types.js';
import { TarWriter, readTarEntry, readTarIndex } from '../../../src/bundle/tar.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import { GENESIS_PREV_HASH, chainHash } from '../../../src/ledger/hash.js';
import type { Checkpoint, LedgerEvent, LedgerEventType } from '../../../src/model/types.js';
import { BlobStore, IndexDb, LocalBackend, type IndexCounts } from '../../../src/storage/index.js';
import { fixedClock, type FixedClock } from '../../helpers/clock.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

const execFileAsync = promisify(execFile);

export const START_MS = Date.UTC(2026, 0, 1);
export const NO_USAGE = { input_tokens: 0, output_tokens: 0 } as const;

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** git against a fixture repo, with inherited GIT_* variables stripped. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export interface Store {
  readonly repo: TmpGitRepo;
  readonly backend: LocalBackend;
  readonly clock: FixedClock;
  readonly service: BundleService;
  /** Where bundles are written by default. Starts empty. */
  readonly outDir: string;
  cleanup(): Promise<void>;
}

export async function openStore(options: { files?: Record<string, string> } = {}): Promise<Store> {
  const repo = await tmpGitRepo(options.files === undefined ? undefined : { files: options.files });
  const clock = fixedClock(START_MS);
  const backend = await LocalBackend.open({ repoDir: repo.dir, clock });
  const outDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'ckpt-bundle-out-'));
  const service = createBundleService({ backend, outDir });
  let closed = false;
  return {
    repo,
    backend,
    clock,
    service,
    outDir,
    async cleanup() {
      if (closed) return;
      closed = true;
      await backend.close();
      await repo.cleanup();
      await rm(outDir, { recursive: true, force: true });
    },
  };
}

/** createCheckpoint over a staging tree holding exactly `files`. */
export async function checkpoint(
  store: Store,
  runId: string,
  parent: string | null,
  files: Record<string, string | Uint8Array>,
  label: string | null = null,
): Promise<Checkpoint> {
  const staging = await mkdtemp(path.join(await realpath(os.tmpdir()), 'ckpt-bundle-staging-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(staging, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const created = await store.backend.createCheckpoint({
      run_id: runId,
      parent_checkpoint_id: parent,
      label,
      pending_intent: [],
      usage: NO_USAGE,
      stagingDir: staging,
    });
    store.clock.tick(1000);
    return created;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function event(store: Store, runId: string, type: LedgerEventType, payload: Record<string, unknown>): Promise<LedgerEvent> {
  const sealed = await store.backend.appendEvent(runId, { type, actor: 'agent', payload });
  store.clock.tick(10);
  return sealed;
}

export const BASE_FILES = { 'README.md': '# demo project\n', 'src/app.ts': 'export const version = 1;\n' } as const;

/** A run whose content no detector flags: 3 tool events, a workspace event and 2 checkpoints. */
export async function seedCleanRun(store: Store): Promise<{ runId: string; checkpoints: Checkpoint[] }> {
  const run = await store.backend.createRun({ agent: 'claude-code' });
  const runId = run.run_id;
  await event(store, runId, 'tool.requested', { tool: 'bash', command: 'ls src' });
  await event(store, runId, 'tool.completed', { stdout: 'app.ts\n', stderr: '' });
  const first = await checkpoint(store, runId, null, BASE_FILES, 'first');
  await event(store, runId, 'workspace.changed', { paths: ['src/app.ts', 'docs/notes.md'] });
  const second = await checkpoint(store, runId, first.checkpoint_id, {
    ...BASE_FILES,
    'src/app.ts': 'export const version = 2;\n',
    'docs/notes.md': 'remember to write the tests\n',
  });
  return { runId, checkpoints: [first, second] };
}

/** An ExportIo that answers `answer` and counts how often it was asked. */
export function answering(answer: string, outPath?: string): ExportIo & { calls: number } {
  const io = {
    calls: 0,
    outPath,
    async confirm(): Promise<string> {
      io.calls += 1;
      return answer;
    },
  };
  return io;
}

/** Every entry under `root`: files as `<size>:<sha256>`, directories as `dir`, symlinks as `link`. */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs);
      const st = await lstat(abs);
      if (st.isDirectory()) {
        out.set(rel, 'dir');
        await walk(abs);
      } else if (st.isSymbolicLink()) {
        out.set(rel, 'link');
      } else {
        out.set(rel, `${st.size}:${sha256(await readFile(abs))}`);
      }
    }
  };
  await walk(root);
  return out;
}

/** Every entry of a bundle tar, in order. */
export async function readBundle(file: string): Promise<Map<string, Buffer>> {
  const handle = await open(file, 'r');
  try {
    const out = new Map<string, Buffer>();
    for (const entry of await readTarIndex(handle)) out.set(entry.name, await readTarEntry(handle, entry));
    return out;
  } finally {
    await handle.close();
  }
}

/** Copy a bundle to `outPath`, changing one entry's content in place (same length) with `mutate`. */
export async function tamperedCopy(bundlePath: string, outPath: string, entryName: string, mutate: (content: Buffer) => void): Promise<void> {
  const handle = await open(bundlePath, 'r');
  let entry;
  try {
    entry = (await readTarIndex(handle)).find((candidate) => candidate.name === entryName);
  } finally {
    await handle.close();
  }
  if (entry === undefined) throw new Error(`bundle has no entry ${entryName}`);
  const bytes = Buffer.from(await readFile(bundlePath));
  mutate(bytes.subarray(entry.offset, entry.offset + entry.size));
  await writeFile(outPath, bytes, { mode: 0o600 });
}

/** Copy a bundle to `outPath` with its entries edited by `edit` (entries keep their order; new ones go last). */
export async function rewrittenCopy(bundlePath: string, outPath: string, edit: (entries: Map<string, Buffer>) => void | Promise<void>): Promise<void> {
  const entries = await readBundle(bundlePath);
  await edit(entries);
  const handle = await open(outPath, 'wx', 0o600);
  try {
    const writer = new TarWriter(handle);
    for (const [name, bytes] of entries) await writer.add(name, bytes);
    await writer.finish();
  } finally {
    await handle.close();
  }
}

/** Edit a bundle's manifest.json in place in `entries`. */
export function editManifest(entries: Map<string, Buffer>, edit: (manifest: BundleManifest) => BundleManifest): void {
  const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as BundleManifest;
  entries.set('manifest.json', Buffer.from(JSON.stringify(edit(manifest)), 'utf8'));
}

/**
 * A ledger (events.jsonl bytes) edited by `edit`, then re-sealed: prev_hash and hash recomputed from
 * genesis. Nothing in a chain is signed, so anyone holding a bundle can do this; import must catch what
 * the chain cannot.
 */
export function resealedLedger(bytes: Buffer, edit: (events: Array<Record<string, any>>) => void): Buffer {
  const events = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, any>);
  edit(events);
  let prev = GENESIS_PREV_HASH;
  const lines = events.map((event) => {
    const sealed: Record<string, unknown> = { ...event, prev_hash: prev };
    sealed['hash'] = chainHash(prev, sealed);
    prev = sealed['hash'] as string;
    return `${canonicalJSON(sealed)}\n`;
  });
  return Buffer.from(lines.join(''), 'utf8');
}

export interface StoreState {
  readonly counts: IndexCounts;
  readonly blobs: string[];
  readonly refs: string;
  readonly runs: string[];
}

/** Index rows, CAS blobs, checkpoint refs and run directories of a store. */
export async function storeState(store: Store): Promise<StoreState> {
  const layout = store.backend.layout;
  const db = IndexDb.open(layout.db);
  let counts: IndexCounts;
  try {
    counts = db.counts();
  } finally {
    db.close();
  }
  return {
    counts,
    blobs: (await new BlobStore(layout.objects, layout.tmp).list()).map((ref) => ref.sha256),
    refs: await git(store.repo.dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/checkpoints']),
    runs: (await readdir(layout.runs)).sort(),
  };
}

export async function allEvents(store: Store, runId: string): Promise<LedgerEvent[]> {
  return store.backend.getEvents(runId, { fromSeq: 1, toSeq: Number.MAX_SAFE_INTEGER });
}
