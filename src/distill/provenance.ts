/**
 * Claim validation (SPEC-007 "Must never ... persist a claim whose provenance is empty, or cites an event
 * id outside ledgerRange / an artifact/checkpoint not in the store"). A failing claim is dropped whole and
 * counted, never repaired.
 */
import type { SemanticClaim } from '../model/types.js';
import { validateSemanticClaim } from '../model/validate.js';
import { DISTILLED_FIELDS, type DistilledField } from './types.js';

export interface ProvenanceContext {
  /** Ids of the events inside ledgerRange that the prompt was built from. */
  readonly eventIds: ReadonlySet<string>;
  /** CAS hashes among this distillation's inputs: the state blob and in-range offloaded payloads. */
  readonly artifactRefs: ReadonlySet<string>;
  hasCheckpoint(checkpointId: string): Promise<boolean>;
}

export interface ClaimValidation {
  readonly claims: SemanticClaim[];
  readonly rejectedClaims: number;
}

export type ParsedClaims = { readonly ok: true; readonly claims: readonly unknown[] } | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the provider's `{"claims": [...]}` reply. A single surrounding ``` fence is tolerated. */
export function parseClaims(text: string): ParsedClaims {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  const body = fenced ? (fenced[1] ?? '') : trimmed;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return { ok: false, reason: `provider reply is not JSON (${(err as Error).message})` };
  }
  if (!isRecord(data) || !Array.isArray(data['claims'])) {
    return { ok: false, reason: 'provider reply must be a JSON object {"claims": [...]}' };
  }
  return { ok: true, claims: data['claims'] };
}

/** A provenance list: absent means empty; anything but an array of non-empty strings is invalid. */
function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') return null;
    out.push(item);
  }
  return out;
}

/** Repo-relative, inside the workspace commit: no absolute path, drive letter or `..` segment. */
function isWorkspacePath(value: string): boolean {
  return !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes('..');
}

function isDistilledField(value: unknown): value is DistilledField {
  return typeof value === 'string' && (DISTILLED_FIELDS as readonly string[]).includes(value);
}

async function checkClaim(candidate: unknown, context: ProvenanceContext): Promise<SemanticClaim | null> {
  if (!isRecord(candidate)) return null;
  const { field, value, confidence, provenance } = candidate;
  if (!isDistilledField(field) || typeof value !== 'string') return null;

  let score: number | undefined;
  if (confidence !== undefined) {
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return null;
    score = confidence;
  }

  if (!isRecord(provenance)) return null;
  const event_ids = stringList(provenance['event_ids']);
  const artifact_refs = stringList(provenance['artifact_refs']);
  const workspace_paths = stringList(provenance['workspace_paths']);
  const checkpoint_ids = stringList(provenance['checkpoint_ids']);
  if (event_ids === null || artifact_refs === null || workspace_paths === null || checkpoint_ids === null) return null;
  if (event_ids.length + artifact_refs.length + workspace_paths.length + checkpoint_ids.length === 0) return null;

  if (!event_ids.every((id) => context.eventIds.has(id))) return null;
  if (!artifact_refs.every((ref) => context.artifactRefs.has(ref))) return null;
  if (!workspace_paths.every(isWorkspacePath)) return null;
  for (const id of checkpoint_ids) {
    if (!(await context.hasCheckpoint(id))) return null;
  }

  // Rebuilt from the checked members only: the origin is always `distilled`, whatever the provider said.
  const claim: SemanticClaim = {
    field,
    value,
    origin: 'distilled',
    ...(score === undefined ? {} : { confidence: score }),
    provenance: { event_ids, artifact_refs, workspace_paths, checkpoint_ids },
  };
  return validateSemanticClaim(claim).ok ? claim : null;
}

/** Keeps the claims whose provenance is non-empty and entirely inside the distillation's evidence. */
export async function validateClaims(candidates: readonly unknown[], context: ProvenanceContext): Promise<ClaimValidation> {
  const claims: SemanticClaim[] = [];
  let rejectedClaims = 0;
  for (const candidate of candidates) {
    const claim = await checkClaim(candidate, context);
    if (claim === null) rejectedClaims += 1;
    else claims.push(claim);
  }
  return { claims, rejectedClaims };
}
