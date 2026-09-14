/**
 * Projection persistence. SPEC-005's StorageBackend has no projection API, so a projection is stored as
 * an immutable CAS blob (its canonical JSON) through putBlob/getBlob. That write touches no ledger event,
 * no git ref and no Agent State Object, so distilling never changes a checkpoint's state hash or ledger
 * head. Projections are never overwritten: re-distilling produces a new id.
 *
 * The id → blob index is held by this object, in process. A durable projection index (index table +
 * reindex) would need a SPEC-005 change and is not built here.
 */
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { canonicalJSON } from '../ledger/canonical-json.js';
import type { BlobRef, SemanticProjection } from '../model/types.js';
import { validateSemanticProjection } from '../model/validate.js';
import { DistillError } from './errors.js';

export interface ProjectionStore {
  /** Persists a validated projection. Rejects with DISTILL_PROJECTION_EXISTS for a stored id. */
  put(projection: SemanticProjection): Promise<void>;
  /** Reads a projection back, validated. Rejects with DISTILL_PROJECTION_NOT_FOUND. */
  get(id: string): Promise<SemanticProjection>;
  /** Every stored projection of `checkpointId`, oldest first. */
  listForCheckpoint(checkpointId: string): Promise<SemanticProjection[]>;
}

/** The blob half of StorageBackend. LocalBackend satisfies it. */
export interface ProjectionBlobs {
  putBlob(data: Uint8Array): Promise<BlobRef>;
  getBlob(ref: BlobRef): Promise<Readable | Uint8Array>;
}

interface Entry {
  readonly checkpointId: string;
  readonly ref: Promise<BlobRef>;
}

function assertValid(value: unknown, what: string): asserts value is SemanticProjection {
  const result = validateSemanticProjection(value);
  if (!result.ok) throw new DistillError('DISTILL_INVALID_PROJECTION', `${what}: ${result.errors.join('; ')}`);
}

export class BlobProjectionStore implements ProjectionStore {
  readonly #blobs: ProjectionBlobs;
  readonly #entries = new Map<string, Entry>();

  constructor(blobs: ProjectionBlobs) {
    this.#blobs = blobs;
  }

  async put(projection: SemanticProjection): Promise<void> {
    assertValid(projection, 'refusing to store an invalid projection');
    const { id, checkpointId } = projection;
    if (this.#entries.has(id)) {
      throw new DistillError('DISTILL_PROJECTION_EXISTS', `projection ${id} is already stored; projections are never overwritten`);
    }
    // Claim the id before the first await, so a concurrent put of the same id is refused too.
    const ref = this.#blobs.putBlob(Buffer.from(canonicalJSON(projection), 'utf8'));
    this.#entries.set(id, { checkpointId, ref });
    try {
      await ref;
    } catch (err) {
      this.#entries.delete(id);
      throw err;
    }
  }

  async get(id: string): Promise<SemanticProjection> {
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new DistillError('DISTILL_PROJECTION_NOT_FOUND', `projection ${id} is not stored`);
    const data = await this.#blobs.getBlob(await entry.ref);
    const bytes = data instanceof Uint8Array ? data : await buffer(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (err) {
      throw new DistillError('DISTILL_INVALID_PROJECTION', `projection ${id} blob is not JSON`, { cause: err });
    }
    assertValid(parsed, `stored projection ${id}`);
    if (parsed.id !== id) throw new DistillError('DISTILL_INVALID_PROJECTION', `blob stored for ${id} holds projection ${parsed.id}`);
    return parsed;
  }

  async listForCheckpoint(checkpointId: string): Promise<SemanticProjection[]> {
    const ids = [...this.#entries].filter(([, entry]) => entry.checkpointId === checkpointId).map(([id]) => id);
    return Promise.all(ids.map((id) => this.get(id)));
  }
}
