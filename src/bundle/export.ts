/**
 * Export (SPEC-011 "Export flow"), in two stages.
 *
 * planExport (stages 1 and 2) enumerates what the bundle holds and runs Redaction's scan over all of it.
 * It reads only durable sources of truth: run.json, events.jsonl, CAS blobs, git objects and refs. It
 * never reads the SQLite index, and it writes nothing: no store file, no git object, no temp file, no
 * bundle byte.
 *
 * writePlannedBundle (stage 4) runs only after the service has checked confirmation. It re-reads the
 * planned content, which is content-addressed (blobs, git objects) or hash-chained (the ledger, whose
 * planned head is re-verified), so the planned hit offsets still apply. It writes a 0600 temp file next
 * to the destination and links it into place, so a failed or interrupted write never leaves a bundle
 * file behind.
 *
 * What a bundle holds for a run (or for a checkpoint: the ledger up to its cursor, and the checkpoints at
 * or before it):
 * - state: the run record and every checkpoint's Agent State Object blob (always);
 * - includeLedger: events.jsonl plus the blobs of over-limit payloads;
 * - includeArtifacts: other stored blobs the included payloads reference as `{sha256, size}`;
 * - includeWorkspace: every git object reachable from the checkpoint commits, and the
 *   refs/checkpoints/<run>/<checkpoint> refs. Never refs/heads/*: checkpoint commits have only
 *   checkpoint commits as parents.
 */
import { randomBytes } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJSON } from '../ledger/canonical-json.js';
import { GENESIS_HEAD, type LedgerHead } from '../ledger/ledger.js';
import { verifyChain } from '../ledger/verify-chain.js';
import type { BlobRef, Checkpoint, LedgerEvent } from '../model/types.js';
import { validateAgentState } from '../model/validate.js';
import { isExcludedPath, type RedactionHit } from '../redact/index.js';
import type { BlobStore } from '../storage/cas.js';
import { errnoCode, fsyncDir } from '../storage/fs-util.js';
import { readEventLog } from '../storage/ledger-log.js';
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN, checkpointNumber, checkpointRefName, runPaths, type StoreLayout } from '../storage/layout.js';
import type { CheckpointRef } from '../storage/types.js';
import { BundleError } from './errors.js';
import { GIT_SHA, encodeGitObject, type BundleGit } from './git.js';
import { MANIFEST_ENTRY, casEntry, gitObjectEntry, ledgerEntry, runRecordEntry } from './layout.js';
import {
  SHA256_HEX,
  blobKey,
  checkpointsFromLedger,
  collectBlobRefs,
  isBlobRefShape,
  parseCanonicalJson,
  parseRunRecord,
  runRecordText,
} from './records.js';
import {
  ISO_TIMESTAMP,
  applyRedactions,
  countEnvEntries,
  isToolOutputEvent,
  jsonSubject,
  rawSubject,
  scanSubject,
  type ExemptRule,
  type ScanSubject,
} from './scan.js';
import { TarWriter } from './tar.js';
import { BUNDLE_FILE_MODE, BUNDLE_SCHEMA_VERSION, type BundleManifest, type BundleScanReport, type ExportOptions } from './types.js';

/**
 * SPEC-011 `export(runId | checkpointId)`. A checkpoint id (`c_<n>`) is unique only within its run, so a
 * checkpoint is named by `{run_id, checkpoint_id}`.
 */
export type ExportTarget = string | CheckpointRef;

export interface BundleContext {
  readonly layout: StoreLayout;
  readonly blobs: BlobStore;
  readonly git: BundleGit;
}

interface PlannedContent {
  readonly hits: readonly RedactionHit[];
}

export interface ExportPlan {
  readonly runId: string;
  readonly unsafe: boolean;
  readonly manifest: BundleManifest;
  readonly report: BundleScanReport;
  readonly runRecord: PlannedContent & { readonly bytes: Buffer };
  readonly ledger: (PlannedContent & { readonly head: LedgerHead }) | null;
  readonly blobs: ReadonlyArray<PlannedContent & { readonly ref: BlobRef }>;
  readonly gitObjects: ReadonlyArray<PlannedContent & { readonly sha: string; readonly size: number }>;
  readonly refs: ReadonlyArray<{ readonly ref: string; readonly sha: string }>;
}

/** Bytes of git object content read per `cat-file --batch` call. */
const GIT_READ_BYTES = 64 * 1024 * 1024;
const GIT_READ_COUNT = 256;

function* sizedChunks<T extends { readonly size: number }>(items: readonly T[]): Generator<T[]> {
  let chunk: T[] = [];
  let bytes = 0;
  for (const item of items) {
    if (chunk.length > 0 && (bytes + item.size > GIT_READ_BYTES || chunk.length >= GIT_READ_COUNT)) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(item);
    bytes += item.size;
  }
  if (chunk.length > 0) yield chunk;
}

function resolveTarget(target: unknown): { runId: string; checkpointId: string | null } {
  if (typeof target === 'string') {
    if (!RUN_ID_PATTERN.test(target)) throw new BundleError('ERR_INVALID_INPUT', `export target must be a run_<ulid> or {run_id, checkpoint_id}, got ${JSON.stringify(target)}`);
    return { runId: target, checkpointId: null };
  }
  const ref = target as Partial<CheckpointRef> | null;
  if (
    typeof ref !== 'object' ||
    ref === null ||
    typeof ref.run_id !== 'string' ||
    !RUN_ID_PATTERN.test(ref.run_id) ||
    typeof ref.checkpoint_id !== 'string' ||
    !CHECKPOINT_ID_PATTERN.test(ref.checkpoint_id)
  ) {
    throw new BundleError('ERR_INVALID_INPUT', `export target must be a run_<ulid> or {run_id, checkpoint_id}, got ${JSON.stringify(target)}`);
  }
  return { runId: ref.run_id, checkpointId: ref.checkpoint_id };
}

function resolveOptions(options: ExportOptions): { workspace: boolean; ledger: boolean; artifacts: boolean; unsafe: boolean } {
  const flag = (name: keyof ExportOptions, fallback: boolean): boolean => {
    const value = options[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new BundleError('ERR_INVALID_INPUT', `export option ${name} must be a boolean`);
    return value;
  };
  return {
    workspace: flag('includeWorkspace', true),
    ledger: flag('includeLedger', true),
    artifacts: flag('includeArtifacts', true),
    unsafe: flag('unsafe', false),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

async function readRunText(file: string, runId: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') throw new BundleError('ERR_NOT_FOUND', `run ${runId} does not exist`);
    throw err;
  }
}

/** Stage 1 and 2: enumerate and scan. Writes nothing. */
export async function planExport(ctx: BundleContext, target: ExportTarget, options: ExportOptions = {}): Promise<ExportPlan> {
  const { runId, checkpointId } = resolveTarget(target);
  const include = resolveOptions(options ?? {});
  const paths = runPaths(ctx.layout, runId);

  // ── what the run holds, by Local Storage's own visibility rule ─────────────────────────────────────
  const runText = await readRunText(paths.runFile, runId);
  const run = parseRunRecord(runText, runId);
  if (run === undefined || runText !== runRecordText(run)) throw new BundleError('ERR_CORRUPT_STORE', `run record of ${runId} is malformed`);

  const log = await readEventLog(paths.events, runId); // read-only: a torn tail is ignored, never truncated here
  const chain = verifyChain(log.events);
  if (!chain.ok) throw new BundleError('ERR_CORRUPT_STORE', `ledger of ${runId} is broken at seq ${chain.brokenAtSeq}: ${chain.reason}`);

  const refs = await ctx.git.listRefs(`refs/checkpoints/${runId}/`);
  const durable: Checkpoint[] = [];
  for (const checkpoint of checkpointsFromLedger(log.events)) {
    if (refs.get(checkpointRefName(runId, checkpoint.checkpoint_id)) !== checkpoint.workspace_commit) continue;
    if (!(await ctx.blobs.has(checkpoint.state_blob))) continue;
    durable.push(checkpoint);
  }

  let events: readonly LedgerEvent[] = log.events;
  let checkpoints: readonly Checkpoint[] = durable;
  if (checkpointId !== null) {
    const chosen = durable.find((checkpoint) => checkpoint.checkpoint_id === checkpointId);
    if (chosen === undefined) throw new BundleError('ERR_NOT_FOUND', `checkpoint ${runId}/${checkpointId} does not exist`);
    events = log.events.filter((event) => event.seq <= chosen.ledger_seq);
    checkpoints = durable.filter((checkpoint) => checkpoint.ledger_seq <= chosen.ledger_seq);
  }
  const last = events.at(-1);
  const head: LedgerHead = last === undefined ? GENESIS_HEAD : { seq: last.seq, hash: last.hash };

  // ── verified identifiers (see scan.ts) ──────────────────────────────────────────────────────────────
  const stored = new Set<string>(checkpoints.map((checkpoint) => blobKey(checkpoint.state_blob)));
  const isStored = async (ref: BlobRef): Promise<boolean> => {
    if (stored.has(blobKey(ref))) return true;
    if (!(await ctx.blobs.has(ref))) return false;
    stored.add(blobKey(ref));
    return true;
  };
  const artifactCandidates = new Map<string, BlobRef>();
  const noteBlobRefs = async (value: unknown): Promise<void> => {
    for (const ref of collectBlobRefs(value).values()) {
      if (await isStored(ref)) artifactCandidates.set(ref.sha256, ref);
    }
  };
  const verifiedBlobRef: ExemptRule = (p, _value, parent) => p[p.length - 1] === 'sha256' && isBlobRefShape(parent) && stored.has(blobKey(parent));
  const verifiedCheckpointSeqs = new Set(checkpoints.map((checkpoint) => checkpoint.ledger_seq));
  const eventRule =
    (event: LedgerEvent): ExemptRule =>
    (p, value, parent) => {
      if (p.length === 1) {
        if (p[0] === 'hash' || p[0] === 'prev_hash') return SHA256_HEX.test(value);
        return p[0] === 'ts' && ISO_TIMESTAMP.test(value);
      }
      if (verifiedBlobRef(p, value, parent)) return true;
      if (event.type !== 'checkpoint.created' || !verifiedCheckpointSeqs.has(event.seq) || p.length !== 2 || p[0] !== 'payload') return false;
      if (p[1] === 'workspace_commit') return GIT_SHA.test(value);
      if (p[1] === 'state_hash') return SHA256_HEX.test(value);
      return p[1] === 'created_at' && ISO_TIMESTAMP.test(value);
    };

  // ── scan ────────────────────────────────────────────────────────────────────────────────────────────
  const report: BundleScanReport = { filesScanned: 0, toolOutputs: 0, envEntries: 0, hits: [] };
  const scan = async (subject: ScanSubject): Promise<RedactionHit[]> => {
    const hits = await scanSubject(subject);
    report.filesScanned += 1;
    for (const hit of hits) report.hits.push(hit);
    return hits;
  };
  const plannedBlobs = new Map<string, PlannedContent & { readonly ref: BlobRef }>();

  // State: the run record and every checkpoint's state blob.
  const runSubject = jsonSubject(runRecordEntry(runId), [{ value: run, rule: (p, value) => p.length === 1 && p[0] === 'created_at' && ISO_TIMESTAMP.test(value) }], '\n');
  const runRecord = { bytes: runSubject.bytes, hits: await scan(runSubject) };

  for (const checkpoint of checkpoints) {
    const bytes = await ctx.blobs.read(checkpoint.state_blob);
    const state = parseCanonicalJson(bytes);
    const valid = validateAgentState(state);
    if (!valid.ok || valid.value.run_id !== runId || valid.value.checkpoint_id !== checkpoint.checkpoint_id) {
      throw new BundleError('ERR_CORRUPT_STORE', `state blob of ${runId}/${checkpoint.checkpoint_id} is malformed`);
    }
    const rule: ExemptRule = (p, value) => p.length === 1 && p[0] === 'workspace_commit' && value === checkpoint.workspace_commit;
    const subject = jsonSubject(casEntry(checkpoint.state_blob.sha256), [{ value: state, rule }], '');
    plannedBlobs.set(checkpoint.state_blob.sha256, { ref: checkpoint.state_blob, hits: await scan(subject) });
  }

  // Ledger: over-limit payload blobs, then the events themselves.
  for (const event of events) {
    const ref = event.payload_ref;
    if (ref !== null) {
      if (!(await isStored(ref))) throw new BundleError('ERR_CORRUPT_STORE', `payload blob ${ref.sha256} of ${runId}#${event.seq} is not in the store`);
      if (!include.ledger || plannedBlobs.has(ref.sha256)) continue;
      const bytes = await ctx.blobs.read(ref);
      const payload = parseCanonicalJson(bytes);
      await noteBlobRefs(payload);
      report.envEntries += countEnvEntries(payload);
      const subject = payload === undefined ? rawSubject(casEntry(ref.sha256), bytes) : jsonSubject(casEntry(ref.sha256), [{ value: payload, rule: verifiedBlobRef }], '');
      plannedBlobs.set(ref.sha256, { ref, hits: await scan(subject) });
    } else {
      await noteBlobRefs(event.payload);
    }
  }
  let ledger: ExportPlan['ledger'] = null;
  if (include.ledger) {
    for (const event of events) {
      if (isToolOutputEvent(event.type)) report.toolOutputs += 1;
      report.envEntries += countEnvEntries(event.payload);
    }
    const subject = jsonSubject(ledgerEntry(runId), events.map((event) => ({ value: event, rule: eventRule(event) })), '\n');
    ledger = { head, hits: await scan(subject) };
  }

  // Artifacts: other stored blobs the included payloads point at.
  if (include.artifacts) {
    for (const ref of [...artifactCandidates.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1))) {
      if (plannedBlobs.has(ref.sha256)) continue;
      const bytes = await ctx.blobs.read(ref);
      plannedBlobs.set(ref.sha256, { ref, hits: await scan(rawSubject(casEntry(ref.sha256), bytes)) });
    }
  }

  // Workspace: the checkpoint commits' objects. A path Redaction excludes is never exported, even unsafe.
  let gitObjects: ExportPlan['gitObjects'] = [];
  let gitRefs: Array<{ ref: string; sha: string }> = [];
  if (include.workspace && checkpoints.length > 0) {
    const shas = await ctx.git.closure([...new Set(checkpoints.map((checkpoint) => checkpoint.workspace_commit))]);
    const info = await ctx.git.inspect(shas);
    const blobPaths = new Map<string, string>();
    const excluded = new Set<string>();
    for (const sha of shas) {
      if (info.get(sha)?.type !== 'commit') continue;
      for (const file of await ctx.git.treeFiles(sha)) {
        if (isExcludedPath(file.path)) excluded.add(file.path);
        if (!blobPaths.has(file.sha)) blobPaths.set(file.sha, file.path);
      }
    }
    if (excluded.size > 0) {
      const names = [...excluded].sort().map((p) => JSON.stringify(p)).join(', ');
      throw new BundleError('ERR_EXCLUDED_PATH', `checkpoint trees of ${runId} hold paths Redaction excludes (${names}); no bundle is written for this run`);
    }

    const sized = shas.map((sha) => {
      const object = info.get(sha);
      if (object == null) throw new BundleError('ERR_CORRUPT_STORE', `git object ${sha} of ${runId} is missing`);
      return { sha, type: object.type, size: object.size };
    });
    const hitsBySha = new Map<string, RedactionHit[]>();
    for (const chunk of sizedChunks(sized.filter((object) => object.type === 'blob'))) {
      for (const object of await ctx.git.readObjects(chunk.map((entry) => entry.sha))) {
        hitsBySha.set(object.sha, await scan(rawSubject(blobPaths.get(object.sha) ?? gitObjectEntry(object.sha), object.content)));
      }
    }
    gitObjects = sized.map(({ sha, size }) => ({ sha, size, hits: hitsBySha.get(sha) ?? [] }));
    gitRefs = checkpoints
      .map((checkpoint) => ({ ref: checkpointRefName(runId, checkpoint.checkpoint_id), sha: checkpoint.workspace_commit }))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1));
  }

  const blobs = [...plannedBlobs.values()].sort((a, b) => (a.ref.sha256 < b.ref.sha256 ? -1 : 1));
  const manifest: BundleManifest = deepFreeze({
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    runIds: [runId],
    checkpointIds: checkpoints.map((checkpoint) => checkpoint.checkpoint_id).sort((a, b) => checkpointNumber(a) - checkpointNumber(b)),
    blobRefs: blobs.map((blob) => `sha256:${blob.ref.sha256}`),
    gitRefs,
    unsafe: include.unsafe,
  });
  return { runId, unsafe: include.unsafe, manifest, report, runRecord, ledger, blobs, gitObjects, refs: gitRefs };
}

/** The planned ledger bytes, re-read and checked against the planned head. */
async function plannedLedgerBytes(ctx: BundleContext, runId: string, head: LedgerHead): Promise<Buffer> {
  const log = await readEventLog(runPaths(ctx.layout, runId).events, runId);
  const events = log.events.filter((event) => event.seq <= head.seq);
  const hash = events.at(-1)?.hash ?? GENESIS_HEAD.hash;
  if (events.length !== head.seq || hash !== head.hash) {
    throw new BundleError('ERR_CORRUPT_STORE', `ledger of ${runId} no longer matches the planned export`);
  }
  return Buffer.from(events.map((event) => `${canonicalJSON(event)}\n`).join(''), 'utf8');
}

/** Stage 4: write the planned bundle to `outPath` (never over an existing file). Returns `outPath`. */
export async function writePlannedBundle(ctx: BundleContext, plan: ExportPlan, outPath: string): Promise<string> {
  const content = (bytes: Buffer, planned: PlannedContent): Buffer => (plan.unsafe ? bytes : applyRedactions(bytes, planned.hits));
  const dir = path.dirname(outPath);
  const partial = path.join(dir, `.${path.basename(outPath)}.${randomBytes(6).toString('hex')}.partial`);

  const handle = await open(partial, 'wx', BUNDLE_FILE_MODE);
  try {
    await handle.chmod(BUNDLE_FILE_MODE);
    const tar = new TarWriter(handle);
    await tar.add(MANIFEST_ENTRY, Buffer.from(`${canonicalJSON(plan.manifest)}\n`, 'utf8'));
    await tar.add(runRecordEntry(plan.runId), content(plan.runRecord.bytes, plan.runRecord));
    if (plan.ledger !== null) {
      await tar.add(ledgerEntry(plan.runId), content(await plannedLedgerBytes(ctx, plan.runId, plan.ledger.head), plan.ledger));
    }
    for (const blob of plan.blobs) {
      await tar.add(casEntry(blob.ref.sha256), content(await ctx.blobs.read(blob.ref), blob));
    }
    const planned = new Map(plan.gitObjects.map((object) => [object.sha, object]));
    for (const chunk of sizedChunks(plan.gitObjects)) {
      for (const object of await ctx.git.readObjects(chunk.map((entry) => entry.sha))) {
        const bytes = object.type === 'blob' ? content(object.content, planned.get(object.sha) ?? { hits: [] }) : object.content;
        await tar.add(gitObjectEntry(object.sha), encodeGitObject(object.type, bytes));
      }
    }
    for (const { ref, sha } of plan.refs) await tar.add(ref, Buffer.from(`${sha}\n`, 'ascii'));
    await tar.finish();
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(partial).catch(() => undefined);
    throw err;
  }
  await handle.close();

  try {
    await link(partial, outPath);
  } catch (err) {
    await unlink(partial).catch(() => undefined);
    if (errnoCode(err) === 'EEXIST') throw new BundleError('ERR_OUTPUT_EXISTS', `${outPath} already exists; a bundle never overwrites a file`);
    throw err;
  }
  await unlink(partial);
  await fsyncDir(dir);
  return outPath;
}
