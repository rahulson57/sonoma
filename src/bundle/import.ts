/**
 * Import (SPEC-011 "Import"): verify the whole bundle, then write it into the store.
 *
 * Verification happens before the first byte is written, and covers:
 * - the tar itself (checksums, regular files only, no unsafe names) and the bundle layout: any other
 *   entry, such as refs/heads/*, rejects the bundle;
 * - every CAS blob's sha256 against its address, and every git object's sha1 against its id;
 * - every ledger line: a valid event for its run, stored exactly as sealed (canonical JSON), and the
 *   hash chain from genesis;
 * - every declared checkpoint: its ref in the bundle points at its workspace_commit, and its state blob
 *   is a valid Agent State Object for it;
 * - completeness: every blob and git object the runs need is in the bundle or already in the store;
 * - the destination: a run that exists with a different head is rejected, never overwritten. A run whose
 *   head is identical is already imported and is left alone.
 * Any mismatch aborts with nothing written.
 *
 * Writes follow Local Storage's visibility order: git objects (unreachable), CAS blobs, events.jsonl,
 * refs (one atomic git transaction), and run.json last, since a run directory without run.json is
 * ignored. The index is then rebuilt with reindex(). If a write fails midway, everything this import
 * created is removed again. Git objects are the exception: they stay unreachable until git prunes them.
 *
 * StorageBackend has no import method, and Local Storage's durable writers are private. So this lays
 * down the same source-of-truth files under the run's lock, using storage's own layout, blob store and
 * fsync primitives.
 */
import { open, rmdir, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { canonicalJSON } from '../ledger/canonical-json.js';
import { GENESIS_HEAD, type LedgerHead } from '../ledger/ledger.js';
import { verifyChain } from '../ledger/verify-chain.js';
import type { BlobRef, LedgerEvent } from '../model/types.js';
import { validateAgentState, validateEvent } from '../model/validate.js';
import { ensureDir, errnoCode, fsyncDir, writeExclusive } from '../storage/fs-util.js';
import { readEventLog } from '../storage/ledger-log.js';
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN, checkpointRefName, runPaths } from '../storage/layout.js';
import { RunLock } from '../storage/lock.js';
import { BundleError } from './errors.js';
import type { BundleContext } from './export.js';
import { GIT_SHA, decodeGitObject, gitObjectId, referencedObjects, type GitObject, type GitObjectType } from './git.js';
import { MANIFEST_ENTRY, parseEntryName, type BundleEntryKind } from './layout.js';
import { checkpointsFromLedger, isRecord, parseCanonicalJson, parseRunRecord, runRecordText, sha256Hex } from './records.js';
import { BundleFormatError, readTarEntry, readTarIndex, type TarEntry } from './tar.js';
import { BUNDLE_SCHEMA_VERSION, type BundleManifest } from './types.js';

export interface ReindexingBackend {
  reindex(): Promise<unknown>;
}

interface VerifiedRun {
  readonly runId: string;
  readonly runBytes: Buffer;
  readonly ledgerBytes: Buffer;
  readonly head: LedgerHead;
  readonly refs: ReadonlyArray<{ readonly ref: string; readonly sha: string }>;
}

interface VerifiedBundle {
  readonly manifest: BundleManifest;
  readonly blobs: ReadonlyMap<string, { readonly ref: BlobRef; readonly entry: TarEntry }>;
  readonly gitObjects: ReadonlyMap<string, { readonly type: GitObjectType; readonly entry: TarEntry }>;
  readonly runs: readonly VerifiedRun[];
}

const invalid = (message: string): BundleError => new BundleError('ERR_INVALID_BUNDLE', message);
const tampered = (message: string): BundleError => new BundleError('ERR_TAMPERED', message);
const incomplete = (message: string): BundleError => new BundleError('ERR_INCOMPLETE_BUNDLE', message);

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

function stringArray(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && pattern.test(item)) && new Set(value).size === value.length;
}

function parseManifest(bytes: Buffer): BundleManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid('manifest.json is not JSON');
  }
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'blobRefs,checkpointIds,gitRefs,runIds,schemaVersion,unsafe') {
    throw invalid('manifest.json must hold exactly schemaVersion, runIds, checkpointIds, blobRefs, gitRefs and unsafe');
  }
  const { schemaVersion, runIds, checkpointIds, blobRefs, gitRefs, unsafe } = value;
  if (schemaVersion !== BUNDLE_SCHEMA_VERSION) throw invalid(`unsupported bundle schemaVersion ${JSON.stringify(schemaVersion)}`);
  if (!stringArray(runIds, RUN_ID_PATTERN) || runIds.length === 0) throw invalid('manifest.json runIds must be distinct run_<ulid> ids');
  if (!Array.isArray(checkpointIds) || !checkpointIds.every((id) => typeof id === 'string' && CHECKPOINT_ID_PATTERN.test(id))) {
    throw invalid('manifest.json checkpointIds must be c_<n> ids');
  }
  if (!stringArray(blobRefs, /^sha256:[0-9a-f]{64}$/)) throw invalid('manifest.json blobRefs must be distinct sha256:<hex> refs');
  if (typeof unsafe !== 'boolean') throw invalid('manifest.json unsafe must be a boolean');
  if (!Array.isArray(gitRefs)) throw invalid('manifest.json gitRefs must be an array');
  const refs = gitRefs.map((item: unknown) => {
    const parsed = isRecord(item) && Object.keys(item).length === 2 && typeof item['ref'] === 'string' ? parseEntryName(item['ref']) : null;
    const sha = isRecord(item) ? item['sha'] : undefined;
    if (parsed?.kind !== 'ref' || typeof sha !== 'string' || !GIT_SHA.test(sha) || !runIds.includes(parsed.runId)) {
      throw invalid(`manifest.json gitRefs entry ${JSON.stringify(item)} is not a refs/checkpoints/<run>/<checkpoint> ref of a bundled run`);
    }
    return { ref: parsed.ref, sha };
  });
  return { schemaVersion, runIds, checkpointIds: checkpointIds as string[], blobRefs, gitRefs: refs, unsafe };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
}

function parseLedger(runId: string, bytes: Buffer): LedgerEvent[] {
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) throw tampered(`ledger of ${runId} does not end with a complete line`);
  const lines = bytes.toString('utf8').split('\n');
  lines.pop();
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw tampered(`ledger of ${runId} line ${index + 1} is not JSON`);
    }
    const valid = validateEvent(parsed);
    if (!valid.ok) throw tampered(`ledger of ${runId} line ${index + 1} is not a ledger event: ${valid.errors.join('; ')}`);
    if (valid.value.run_id !== runId) throw tampered(`ledger of ${runId} line ${index + 1} belongs to ${valid.value.run_id}`);
    if (canonicalJSON(valid.value) !== line) throw tampered(`ledger of ${runId} line ${index + 1} is not the event as it was sealed`);
    return valid.value;
  });
}

async function verifyBundle(ctx: BundleContext, handle: FileHandle): Promise<VerifiedBundle> {
  let index: TarEntry[];
  try {
    index = await readTarIndex(handle);
  } catch (err) {
    if (err instanceof BundleFormatError) throw new BundleError('ERR_INVALID_BUNDLE', err.message, { cause: err });
    throw err;
  }
  const named: Array<{ entry: TarEntry; kind: BundleEntryKind }> = [];
  const foreign: string[] = [];
  for (const entry of index) {
    const kind = parseEntryName(entry.name);
    if (kind === null) foreign.push(entry.name);
    else named.push({ entry, kind });
  }
  if (foreign.length > 0) throw invalid(`bundle holds entries outside the bundle layout: ${foreign.map((n) => JSON.stringify(n)).join(', ')}`);

  const manifestEntry = index.find((entry) => entry.name === MANIFEST_ENTRY);
  if (manifestEntry === undefined) throw invalid('bundle has no manifest.json');
  const manifest = parseManifest(await readTarEntry(handle, manifestEntry));

  // CAS blobs: bytes against address.
  const blobs = new Map<string, { ref: BlobRef; entry: TarEntry }>();
  for (const { entry, kind } of named) {
    if (kind.kind !== 'cas') continue;
    const actual = sha256Hex(await readTarEntry(handle, entry));
    if (actual !== kind.sha256) throw tampered(`blob ${kind.sha256} does not match its address (its bytes hash to ${actual})`);
    blobs.set(kind.sha256, { ref: { sha256: kind.sha256, size: entry.size }, entry });
  }
  if (!sameMembers([...blobs.keys()].map((sha) => `sha256:${sha}`), manifest.blobRefs)) throw invalid('objects/sha256 entries do not match manifest.json blobRefs');
  const hasBlob = async (ref: BlobRef): Promise<boolean> => blobs.get(ref.sha256)?.ref.size === ref.size || (await ctx.blobs.has(ref));

  // Git objects: bytes against id.
  const gitObjects = new Map<string, { type: GitObjectType; entry: TarEntry; references: string[] }>();
  for (const { entry, kind } of named) {
    if (kind.kind !== 'git') continue;
    const bytes = await readTarEntry(handle, entry);
    const actual = gitObjectId(bytes);
    if (actual !== kind.sha) throw tampered(`git object ${kind.sha} does not match its id (its bytes hash to ${actual})`);
    const { type, content } = decodeGitObject(bytes);
    gitObjects.set(kind.sha, { type, entry, references: referencedObjects(type, content) });
  }

  // Refs.
  const bundleRefs = new Map<string, { runId: string; sha: string }>();
  for (const { entry, kind } of named) {
    if (kind.kind !== 'ref') continue;
    const text = (await readTarEntry(handle, entry)).toString('latin1');
    if (!/^[0-9a-f]{40}\n$/.test(text)) throw invalid(`ref entry ${kind.ref} does not hold an object id`);
    bundleRefs.set(kind.ref, { runId: kind.runId, sha: text.slice(0, 40) });
  }
  if (!sameMembers([...bundleRefs].map(([ref, { sha }]) => `${ref} ${sha}`), manifest.gitRefs.map(({ ref, sha }) => `${ref} ${sha}`))) {
    throw invalid('refs/checkpoints entries do not match manifest.json gitRefs');
  }

  // Runs: record, ledger chain, checkpoints.
  for (const { kind } of named) {
    if ((kind.kind === 'run' || kind.kind === 'ledger' || kind.kind === 'ref') && !manifest.runIds.includes(kind.runId)) {
      throw invalid(`bundle holds content of run ${kind.runId}, which manifest.json does not list`);
    }
  }
  const runs: VerifiedRun[] = [];
  const declaredCheckpoints: string[] = [];
  for (const runId of manifest.runIds) {
    const runEntry = index.find((entry) => entry.name === `runs/${runId}/run.json`);
    const ledgerEntry = index.find((entry) => entry.name === `runs/${runId}/events.jsonl`);
    if (runEntry === undefined || ledgerEntry === undefined) {
      throw incomplete(`bundle has no ${runEntry === undefined ? 'run record' : 'ledger'} for ${runId} (exported without it), so it cannot be imported`);
    }
    const runBytes = await readTarEntry(handle, runEntry);
    const run = parseRunRecord(runBytes.toString('utf8'), runId);
    if (run === undefined || runBytes.toString('utf8') !== runRecordText(run)) throw tampered(`run record of ${runId} is not the record Local Storage wrote`);

    const ledgerBytes = await readTarEntry(handle, ledgerEntry);
    const events = parseLedger(runId, ledgerBytes);
    const chain = verifyChain(events);
    if (!chain.ok) throw tampered(`ledger hash chain of ${runId} is broken at seq ${chain.brokenAtSeq}: ${chain.reason}`);
    for (const event of events) {
      if (event.payload_ref !== null && !(await hasBlob(event.payload_ref))) {
        throw incomplete(`payload blob ${event.payload_ref.sha256} of ${runId}#${event.seq} is neither in the bundle nor in this store`);
      }
    }

    const refs: Array<{ ref: string; sha: string }> = [];
    for (const checkpoint of checkpointsFromLedger(events)) {
      const ref = checkpointRefName(runId, checkpoint.checkpoint_id);
      const bundled = bundleRefs.get(ref);
      if (bundled === undefined) throw incomplete(`bundle has no ref for checkpoint ${runId}/${checkpoint.checkpoint_id} (exported without the workspace), so it cannot be imported`);
      if (bundled.sha !== checkpoint.workspace_commit) throw tampered(`ref ${ref} does not point at the commit its checkpoint records`);
      const state = blobs.get(checkpoint.state_blob.sha256);
      if (state !== undefined) {
        const valid = validateAgentState(parseCanonicalJson(await readTarEntry(handle, state.entry)));
        if (
          !valid.ok ||
          valid.value.run_id !== runId ||
          valid.value.checkpoint_id !== checkpoint.checkpoint_id ||
          valid.value.workspace_commit !== checkpoint.workspace_commit ||
          valid.value.ledger_seq !== checkpoint.ledger_seq
        ) {
          throw tampered(`state blob of ${runId}/${checkpoint.checkpoint_id} is not that checkpoint's state`);
        }
      } else if (!(await ctx.blobs.has(checkpoint.state_blob))) {
        throw incomplete(`state blob of ${runId}/${checkpoint.checkpoint_id} is neither in the bundle nor in this store`);
      }
      refs.push({ ref, sha: bundled.sha });
      declaredCheckpoints.push(checkpoint.checkpoint_id);
    }
    const runRefCount = [...bundleRefs.values()].filter((bundled) => bundled.runId === runId).length;
    if (runRefCount !== refs.length) throw invalid(`bundle holds refs of ${runId} that no checkpoint in its ledger declares`);

    const last = events.at(-1);
    runs.push({ runId, runBytes, ledgerBytes, head: last === undefined ? GENESIS_HEAD : { seq: last.seq, hash: last.hash }, refs });
  }
  if (!sameMembers(declaredCheckpoints, manifest.checkpointIds)) throw invalid('checkpoints declared by the ledgers do not match manifest.json checkpointIds');

  // Every object the refs reach is in the bundle or already in this repository.
  const external = new Set<string>();
  const seen = new Set<string>();
  const pending = runs.flatMap((run) => run.refs.map(({ sha }) => sha));
  for (const run of runs) {
    for (const { ref, sha } of run.refs) {
      const object = gitObjects.get(sha);
      if (object !== undefined && object.type !== 'commit') throw invalid(`ref ${ref} does not point at a commit`);
    }
  }
  while (pending.length > 0) {
    const sha = pending.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = gitObjects.get(sha);
    if (object === undefined) external.add(sha);
    else pending.push(...object.references);
  }
  const present = await ctx.git.inspect([...external]);
  const missing = [...external].filter((sha) => present.get(sha) == null);
  if (missing.length > 0) throw incomplete(`bundle lacks ${missing.length} git object(s) its refs need (e.g. ${missing[0]}), and this repository does not have them`);

  return {
    manifest,
    blobs,
    gitObjects: new Map([...gitObjects].map(([sha, { type, entry }]) => [sha, { type, entry }])),
    runs,
  };
}

/** True when any entry carries a redaction marker: the bundle was written with redactions. */
async function carriesRedactions(handle: FileHandle): Promise<boolean> {
  try {
    for (const entry of await readTarIndex(handle)) {
      if ((await readTarEntry(handle, entry)).includes('[REDACTED:')) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Runs of the bundle that must be written: absent from the store. A run with a different head rejects the import. */
async function runsToWrite(ctx: BundleContext, bundle: VerifiedBundle): Promise<VerifiedRun[]> {
  const out: VerifiedRun[] = [];
  for (const run of bundle.runs) {
    const paths = runPaths(ctx.layout, run.runId);
    const existingRefs = await ctx.git.listRefs(`refs/checkpoints/${run.runId}/`);
    if (!(await pathExists(paths.dir)) && existingRefs.size === 0) {
      out.push(run);
      continue;
    }
    let storeHead: LedgerHead | undefined;
    if (await pathExists(paths.runFile)) {
      const last = (await readEventLog(paths.events, run.runId)).events.at(-1);
      storeHead = last === undefined ? GENESIS_HEAD : { seq: last.seq, hash: last.hash };
    }
    if (storeHead !== undefined && storeHead.seq === run.head.seq && storeHead.hash === run.head.hash) continue;
    throw new BundleError(
      'ERR_RUN_EXISTS',
      `run ${run.runId} already exists in this store with a different head (store seq ${storeHead?.seq ?? 'unknown'}, bundle seq ${run.head.seq}); import never overwrites a run`,
    );
  }
  return out;
}

async function writeRuns(ctx: BundleContext, handle: FileHandle, bundle: VerifiedBundle, runs: readonly VerifiedRun[]): Promise<void> {
  const locks: RunLock[] = [];
  const undo: Array<() => Promise<unknown>> = [];
  try {
    for (const run of runs) locks.push(await RunLock.acquire(ctx.layout.lock, run.runId));
    // Re-check under the locks: nothing may have created the runs in the meantime.
    if ((await runsToWrite(ctx, bundle)).length !== runs.length) {
      throw new BundleError('ERR_RUN_EXISTS', 'a run of this bundle was created in the store while the bundle was being verified');
    }

    // 1. Git objects the repository lacks (unreachable until step 4).
    const shas = [...bundle.gitObjects.keys()];
    const present = await ctx.git.inspect(shas);
    const needed: GitObject[] = [];
    for (const sha of shas) {
      if (present.get(sha) != null) continue;
      const { entry } = bundle.gitObjects.get(sha)!;
      const bytes = await readTarEntry(handle, entry);
      if (gitObjectId(bytes) !== sha) throw tampered(`git object ${sha} changed after verification`);
      needed.push({ sha, ...decodeGitObject(bytes) });
    }
    await ctx.git.writeObjects(needed, ctx.layout.tmp);

    // 2. CAS blobs the store lacks.
    for (const { ref, entry } of bundle.blobs.values()) {
      if (await ctx.blobs.has(ref)) continue;
      const bytes = await readTarEntry(handle, entry);
      if (sha256Hex(bytes) !== ref.sha256) throw tampered(`blob ${ref.sha256} changed after verification`);
      await ctx.blobs.put(bytes);
      undo.push(() => unlink(ctx.blobs.pathFor(ref.sha256)));
    }

    // 3. Ledgers.
    for (const run of runs) {
      const paths = runPaths(ctx.layout, run.runId);
      await ensureDir(paths.dir);
      undo.push(() => rmdir(paths.dir));
      await writeExclusive(paths.events, run.ledgerBytes);
      undo.push(() => unlink(paths.events));
    }

    // 4. Refs, in one transaction.
    const refs = runs.flatMap((run) => run.refs);
    await ctx.git.createRefs(refs);
    undo.push(() => ctx.git.deleteRefs(refs));

    // 5. Run records last: until run.json exists, reindex ignores the run directory.
    for (const run of runs) {
      const paths = runPaths(ctx.layout, run.runId);
      await writeExclusive(paths.runFile, run.runBytes);
      undo.push(() => unlink(paths.runFile));
      await fsyncDir(paths.dir);
    }
    await fsyncDir(ctx.layout.runs);
  } catch (err) {
    for (const step of undo.reverse()) await step().catch(() => undefined);
    throw err;
  } finally {
    for (const lock of locks) await lock.release().catch(() => undefined);
  }
}

/** SPEC-011 importBundle: verify, then write. Returns the bundle's run ids. */
export async function importBundle(ctx: BundleContext, backend: ReindexingBackend, bundlePath: string): Promise<{ runIds: string[] }> {
  let handle: FileHandle;
  try {
    handle = await open(bundlePath, 'r');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') throw new BundleError('ERR_NOT_FOUND', `bundle ${bundlePath} does not exist`);
    throw err;
  }
  try {
    let bundle: VerifiedBundle;
    try {
      bundle = await verifyBundle(ctx, handle);
    } catch (err) {
      if (err instanceof BundleError && err.code === 'ERR_TAMPERED' && (await carriesRedactions(handle))) {
        throw new BundleError(
          'ERR_TAMPERED',
          `${err.message.replace(/^ERR_TAMPERED: /, '')} (this bundle was written with redactions, which change hashed bytes, so it cannot be verified; export again with --unsafe for an importable bundle)`,
          { cause: err },
        );
      }
      throw err;
    }
    const runs = await runsToWrite(ctx, bundle);
    if (runs.length > 0) {
      await writeRuns(ctx, handle, bundle, runs);
      try {
        await backend.reindex();
      } catch (err) {
        throw new BundleError('ERR_REINDEX', 'the bundle was imported, but the index could not be rebuilt; run reindex', { cause: err });
      }
    }
    return { runIds: [...bundle.manifest.runIds] };
  } finally {
    await handle.close();
  }
}
