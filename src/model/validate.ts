/**
 * Validation for the canonical model (SPEC-004 "Returns: validated LedgerEvent and Checkpoint values").
 *
 * Each validator checks the value against its `schema/*.json` file, then applies the cross-field rules
 * JSON Schema cannot express. A validator never mutates or coerces its input. The one exception is
 * SideEffect: a missing reversibility is filled in as `irreversible` on a copy (SPEC-004 default).
 */
import type { SchemaIssue } from './json-schema.js';
import { validateAgainst, type SchemaName } from './schemas.js';
import {
  DEFAULT_REVERSIBILITY,
  KNOWN_SCHEMA_VERSIONS,
  type AgentStateObject,
  type Checkpoint,
  type LedgerEvent,
  type SemanticClaim,
  type SemanticProjection,
  type SideEffect,
  type SideEffectInput,
} from './types.js';

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export class ModelValidationError extends Error {
  override readonly name = 'ModelValidationError';
  readonly kind: string;
  readonly errors: readonly string[];

  constructor(kind: string, errors: readonly string[]) {
    super(`invalid ${kind}: ${errors.join('; ')}`);
    this.kind = kind;
    this.errors = errors;
  }
}

function formatIssue(issue: SchemaIssue): string {
  return `${issue.path === '' ? '/' : issue.path}: ${issue.message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checked<T>(name: SchemaName, value: unknown, rules?: (value: T) => string[]): Result<T> {
  const result = validateAgainst(name, value);
  if (!result.ok) return { ok: false, errors: result.issues.map(formatIssue) };
  const errors = rules ? rules(value as T) : [];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as T };
}

/** A present-but-unknown schemaVersion gets a precise error before any structural check. */
function unknownVersion(value: unknown): string[] {
  if (!isRecord(value) || value['schemaVersion'] === undefined) return [];
  const version = value['schemaVersion'];
  return typeof version === 'number' && KNOWN_SCHEMA_VERSIONS.includes(version)
    ? []
    : [`/schemaVersion: unknown schemaVersion ${JSON.stringify(version)} (this build knows ${KNOWN_SCHEMA_VERSIONS.join(', ')})`];
}

export function validateCheckpoint(value: unknown): Result<Checkpoint> {
  const version = unknownVersion(value);
  if (version.length > 0) return { ok: false, errors: version };
  return checked<Checkpoint>('checkpoint', value, (cp) => {
    const errors: string[] = [];
    if (cp.state_hash !== cp.state_blob.sha256) {
      errors.push('/state_hash: must equal state_blob.sha256 (the hash of the stored Agent State Object)');
    }
    if (cp.parent_checkpoint_id === cp.checkpoint_id) {
      errors.push('/parent_checkpoint_id: a checkpoint cannot be its own parent');
    }
    return errors;
  });
}

/** Architecture interface `validateEvent(obj): Result<LedgerEvent>` — shape only; chain integrity is verifyChain. */
export function validateEvent(value: unknown): Result<LedgerEvent> {
  return checked<LedgerEvent>('ledgerEvent', value);
}

export function validateSemanticClaim(value: unknown): Result<SemanticClaim> {
  return checked<SemanticClaim>('semanticClaim', value);
}

/**
 * SPEC-004 v3 / SPEC-015 amendment 3: a `distilled` projection must name its distiller and record its usage.
 * Only a `declared` projection may leave either null.
 */
export function validateSemanticProjection(value: unknown): Result<SemanticProjection> {
  return checked<SemanticProjection>('semanticProjection', value, (projection) => {
    const errors: string[] = [];
    const [from, to] = projection.input.ledgerRange;
    if (from > to) errors.push(`/input/ledgerRange: start ${from} is after end ${to}`);
    if (projection.source === 'distilled') {
      if (projection.distiller === null) errors.push("/distiller: a projection with source 'distilled' needs a distiller block");
      if (projection.usage === null) errors.push("/usage: a projection with source 'distilled' needs its usage");
    }
    return errors;
  });
}

export function validateAgentState(value: unknown): Result<AgentStateObject> {
  const version = unknownVersion(value);
  if (version.length > 0) return { ok: false, errors: version };
  return checked<AgentStateObject>('agentState', value);
}

/**
 * Validates a SideEffect. When reversibility is absent (or undefined), the returned value is a copy
 * with `reversibility: 'irreversible'`. An explicit but unknown value is rejected, never defaulted.
 */
export function validateSideEffect(value: unknown): Result<SideEffect> {
  const normalized =
    isRecord(value) && value['reversibility'] === undefined ? { ...value, reversibility: DEFAULT_REVERSIBILITY } : value;
  return checked<SideEffect>('sideEffect', normalized);
}

/** Build a SideEffect, defaulting reversibility to `irreversible`. Throws ModelValidationError. */
export function createSideEffect(input: SideEffectInput): SideEffect {
  const result = validateSideEffect(input);
  if (!result.ok) throw new ModelValidationError('SideEffect', result.errors);
  return result.value;
}
