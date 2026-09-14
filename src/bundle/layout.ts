/**
 * Entry layout of a bundle tar (SPEC-011 `bundleFile`: manifest.json + objects/sha256/** + refs, plus
 * what the round trip needs to carry: the run record, its ledger and the git objects behind the refs).
 *
 *   manifest.json                              BundleManifest
 *   runs/<run_id>/run.json                     run record, as Local Storage wrote it
 *   runs/<run_id>/events.jsonl                 the run's ledger (one canonical JSON event per line)
 *   objects/sha256/<first 2 hex>/<sha256>      CAS blobs: state, over-limit payloads, artifacts
 *   git/objects/<sha1>                         git objects in loose encoding `<type> <size>\0<content>`
 *   refs/checkpoints/<run_id>/<checkpoint_id>  file holding the ref's object id and a newline
 *
 * Nothing else is ever a valid entry: import rejects any other name, so a bundle can never carry
 * refs/heads/* or a workspace path as a file of its own.
 */
import { CHECKPOINT_ID_PATTERN, RUN_ID_PATTERN } from '../storage/layout.js';

export const MANIFEST_ENTRY = 'manifest.json';

export function casEntry(sha256: string): string {
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function runRecordEntry(runId: string): string {
  return `runs/${runId}/run.json`;
}

export function ledgerEntry(runId: string): string {
  return `runs/${runId}/events.jsonl`;
}

export function gitObjectEntry(sha: string): string {
  return `git/objects/${sha}`;
}

export type BundleEntryKind =
  | { readonly kind: 'manifest' }
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'ledger'; readonly runId: string }
  | { readonly kind: 'cas'; readonly sha256: string }
  | { readonly kind: 'git'; readonly sha: string }
  | { readonly kind: 'ref'; readonly ref: string; readonly runId: string; readonly checkpointId: string };

/** What a bundle entry name addresses, or null when it is not part of the bundle layout. */
export function parseEntryName(name: string): BundleEntryKind | null {
  if (name === MANIFEST_ENTRY) return { kind: 'manifest' };

  const cas = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(name);
  if (cas) return cas[2]!.startsWith(cas[1]!) ? { kind: 'cas', sha256: cas[2]! } : null;

  const run = /^runs\/([^/]+)\/(run\.json|events\.jsonl)$/.exec(name);
  if (run) {
    const runId = run[1]!;
    if (!RUN_ID_PATTERN.test(runId)) return null;
    return run[2] === 'run.json' ? { kind: 'run', runId } : { kind: 'ledger', runId };
  }

  const git = /^git\/objects\/([0-9a-f]{40})$/.exec(name);
  if (git) return { kind: 'git', sha: git[1]! };

  const ref = /^refs\/checkpoints\/([^/]+)\/([^/]+)$/.exec(name);
  if (ref && RUN_ID_PATTERN.test(ref[1]!) && CHECKPOINT_ID_PATTERN.test(ref[2]!)) {
    return { kind: 'ref', ref: name, runId: ref[1]!, checkpointId: ref[2]! };
  }
  return null;
}
