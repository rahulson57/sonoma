/**
 * SQLite metadata index `.ckpt/checkpoint.db` (SPEC-005): runs, checkpoints (with parents), ledger
 * event rows, blob refs, the change-detection cache, and (SPEC-015 amendment 4) projections and their claims.
 *
 * Projection and claim rows hold only index columns plus the projection's CAS blob ref. The projection itself,
 * claim values included, lives only in CAS, which is its source of truth, so no claim text is copied into this
 * file.
 *
 * NOT a source of truth. Everything here is rebuilt by `reindex()` from runs/, CAS and git refs, so
 * the file can be deleted at any time. WAL journal mode; the database file is created 0600 before
 * SQLite opens it, and SQLite creates its -wal/-shm files with the database file's permissions.
 *
 * Driver: better-sqlite3 (DEC-018). It is imported only here, so no other module depends on it.
 *
 * Events and checkpoints are stored as their canonical JSON record so they read back byte-for-byte
 * as sealed (S03 verifyChain must still pass). Over-limit payloads never reach this file: the ledger
 * offloads them to CAS as payload_ref, and insertEvent refuses an inline payload over the limit.
 */
import { closeSync, fchmodSync, openSync } from 'node:fs';
import Database from 'better-sqlite3';
import { canonicalJSON } from '../ledger/canonical-json.js';
import { MAX_INLINE_PAYLOAD_BYTES } from '../ledger/ledger.js';
import type { BlobRef, Checkpoint, LedgerEvent, Run } from '../model/types.js';
import type { FileCache, FileCacheEntry } from './change-detection.js';
import { StorageError } from './errors.js';
import { FILE_MODE } from './fs-util.js';
import { checkpointNumber } from './layout.js';

const INDEX_FORMAT = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id                 TEXT PRIMARY KEY,
  parent_run_id          TEXT,
  forked_from_checkpoint TEXT,
  agent                  TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  record                 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  event_id       TEXT NOT NULL,
  type           TEXT NOT NULL,
  ts             TEXT NOT NULL,
  payload_sha256 TEXT,
  record         TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id               TEXT NOT NULL,
  n                    INTEGER NOT NULL,
  checkpoint_id        TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  label                TEXT,
  workspace_commit     TEXT NOT NULL,
  state_hash           TEXT NOT NULL,
  ledger_seq           INTEGER NOT NULL,
  record               TEXT NOT NULL,
  PRIMARY KEY (run_id, n)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS file_cache (
  run_id       TEXT NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime_ns     TEXT NOT NULL,
  inode        TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  hashed_at_ns TEXT NOT NULL,
  PRIMARY KEY (run_id, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS checkpoints_by_state ON checkpoints (checkpoint_id, state_hash);
CREATE TABLE IF NOT EXISTS projections (
  projection_id TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  n             INTEGER NOT NULL,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  blob_sha256   TEXT NOT NULL,
  blob_size     INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS projections_by_checkpoint ON projections (run_id, n, created_at, projection_id);
CREATE TABLE IF NOT EXISTS claims (
  projection_id TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  run_id        TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  field         TEXT NOT NULL,
  origin        TEXT NOT NULL,
  PRIMARY KEY (projection_id, idx)
) WITHOUT ROWID;
`;

/** One projection's index rows: the projection row and one claim row per claim, in claim order. */
export interface ProjectionIndexEntry {
  readonly projection_id: string;
  readonly run_id: string;
  readonly checkpoint_id: string;
  readonly source: string;
  readonly created_at: string;
  /** The CAS blob holding the projection's canonical JSON. */
  readonly ref: BlobRef;
  readonly claims: ReadonlyArray<{ readonly field: string; readonly origin: string }>;
}

export interface IndexedProjection {
  readonly projection_id: string;
  readonly ref: BlobRef;
}

export interface IndexCounts {
  readonly runs: number;
  readonly checkpoints: number;
  readonly events: number;
}

type Row = Record<string, unknown>;

function parseRecord<T>(row: Row, what: string): T {
  try {
    return JSON.parse(String(row['record'])) as T;
  } catch (err) {
    throw new StorageError('ERR_CORRUPT', `unreadable ${what} row in checkpoint.db; run reindex`, { cause: err });
  }
}

export class IndexDb {
  readonly #db: Database.Database;
  readonly #statements = new Map<string, Database.Statement>();
  #closed = false;

  private constructor(db: Database.Database) {
    this.#db = db;
  }

  static open(file: string): IndexDb {
    const fd = openSync(file, 'a', FILE_MODE);
    try {
      fchmodSync(fd, FILE_MODE);
    } finally {
      closeSync(fd);
    }
    const db = new Database(file, { timeout: 5000 });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.exec(SCHEMA);
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('index_format') as Row | undefined;
      if (row === undefined) {
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('index_format', INDEX_FORMAT);
      } else if (row['value'] !== INDEX_FORMAT) {
        throw new StorageError('ERR_CORRUPT', `checkpoint.db has index format ${String(row['value'])}, expected ${INDEX_FORMAT}`);
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new IndexDb(db);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }

  /** Run `fn` inside one write transaction (BEGIN IMMEDIATE … COMMIT, rolled back if it throws). */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn).immediate();
  }

  #stmt(sql: string): Database.Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #get(sql: string, ...params: unknown[]): Row | undefined {
    return this.#stmt(sql).get(...params) as Row | undefined;
  }

  #all(sql: string, ...params: unknown[]): Row[] {
    return this.#stmt(sql).all(...params) as Row[];
  }

  // ── runs ──────────────────────────────────────────────────────────────────────────────────────

  insertRun(run: Run, options: { ignoreExisting?: boolean } = {}): void {
    const verb = options.ignoreExisting ? 'INSERT OR IGNORE' : 'INSERT';
    this.#stmt(
      `${verb} INTO runs (run_id, parent_run_id, forked_from_checkpoint, agent, created_at, record) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(run.run_id, run.parent_run_id, run.forked_from_checkpoint, run.agent, run.created_at, canonicalJSON(run));
  }

  getRun(runId: string): Run | undefined {
    const row = this.#get('SELECT record FROM runs WHERE run_id = ?', runId);
    return row === undefined ? undefined : parseRecord<Run>(row, 'run');
  }

  /** Every indexed run, forks included, by created_at then run_id. */
  listRuns(): Run[] {
    return this.#all('SELECT record FROM runs ORDER BY created_at, run_id').map((row) => parseRecord<Run>(row, 'run'));
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────────

  insertEvent(event: LedgerEvent): void {
    const record = canonicalJSON(event);
    if (
      event.payload !== null &&
      Buffer.byteLength(record, 'utf8') > MAX_INLINE_PAYLOAD_BYTES &&
      Buffer.byteLength(canonicalJSON(event.payload), 'utf8') > MAX_INLINE_PAYLOAD_BYTES
    ) {
      throw new StorageError(
        'ERR_INLINE_TOO_LARGE',
        `event ${event.run_id}#${event.seq} carries an inline payload over ${MAX_INLINE_PAYLOAD_BYTES} bytes; it must be a payload_ref`,
      );
    }
    this.#stmt(
      'INSERT INTO events (run_id, seq, event_id, type, ts, payload_sha256, record) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(event.run_id, event.seq, event.event_id, event.type, event.ts, event.payload_ref?.sha256 ?? null, record);
  }

  /** Events with fromSeq <= seq <= toSeq, in seq order. */
  getEvents(runId: string, fromSeq: number, toSeq: number): LedgerEvent[] {
    return this.#all('SELECT record FROM events WHERE run_id = ? AND seq >= ? AND seq <= ? ORDER BY seq', runId, fromSeq, toSeq).map((row) =>
      parseRecord<LedgerEvent>(row, 'event'),
    );
  }

  maxEventSeq(runId: string): number {
    return Number(this.#get('SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE run_id = ?', runId)?.['n'] ?? 0);
  }

  // ── checkpoints ───────────────────────────────────────────────────────────────────────────────

  insertCheckpoint(checkpoint: Checkpoint): void {
    this.#stmt(
      `INSERT INTO checkpoints (run_id, n, checkpoint_id, parent_checkpoint_id, label, workspace_commit, state_hash, ledger_seq, record)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpoint.run_id,
      checkpointNumber(checkpoint.checkpoint_id),
      checkpoint.checkpoint_id,
      checkpoint.parent_checkpoint_id,
      checkpoint.label,
      checkpoint.workspace_commit,
      checkpoint.state_hash,
      checkpoint.ledger_seq,
      canonicalJSON(checkpoint),
    );
  }

  getCheckpoint(runId: string, checkpointId: string): Checkpoint | undefined {
    const row = this.#get('SELECT record FROM checkpoints WHERE run_id = ? AND checkpoint_id = ?', runId, checkpointId);
    return row === undefined ? undefined : parseRecord<Checkpoint>(row, 'checkpoint');
  }

  listCheckpoints(runId: string): Checkpoint[] {
    return this.#all('SELECT record FROM checkpoints WHERE run_id = ? ORDER BY n', runId).map((row) => parseRecord<Checkpoint>(row, 'checkpoint'));
  }

  /** The checkpoint with this id whose state blob hashes to `stateHash` (the state embeds run and checkpoint ids). */
  findCheckpointByState(checkpointId: string, stateHash: string): Checkpoint | undefined {
    const row = this.#get(
      'SELECT record FROM checkpoints WHERE checkpoint_id = ? AND state_hash = ? ORDER BY run_id LIMIT 1',
      checkpointId,
      stateHash,
    );
    return row === undefined ? undefined : parseRecord<Checkpoint>(row, 'checkpoint');
  }

  // ── projections and claims ────────────────────────────────────────────────────────────────────

  insertProjection(entry: ProjectionIndexEntry): void {
    this.#stmt(
      `INSERT INTO projections (projection_id, run_id, checkpoint_id, n, source, created_at, blob_sha256, blob_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.projection_id,
      entry.run_id,
      entry.checkpoint_id,
      checkpointNumber(entry.checkpoint_id),
      entry.source,
      entry.created_at,
      entry.ref.sha256,
      entry.ref.size,
    );
    entry.claims.forEach((claim, idx) => {
      this.#stmt('INSERT INTO claims (projection_id, idx, run_id, checkpoint_id, field, origin) VALUES (?, ?, ?, ?, ?, ?)').run(
        entry.projection_id,
        idx,
        entry.run_id,
        entry.checkpoint_id,
        claim.field,
        claim.origin,
      );
    });
  }

  getProjectionRef(projectionId: string): BlobRef | undefined {
    const row = this.#get('SELECT blob_sha256, blob_size FROM projections WHERE projection_id = ?', projectionId);
    return row === undefined ? undefined : { sha256: String(row['blob_sha256']), size: Number(row['blob_size']) };
  }

  /** The projections of one checkpoint, by createdAt then id. */
  listProjections(runId: string, checkpointId: string): IndexedProjection[] {
    return this.#all(
      'SELECT projection_id, blob_sha256, blob_size FROM projections WHERE run_id = ? AND n = ? ORDER BY created_at, projection_id',
      runId,
      checkpointNumber(checkpointId),
    ).map((row) => ({ projection_id: String(row['projection_id']), ref: { sha256: String(row['blob_sha256']), size: Number(row['blob_size']) } }));
  }

  projectionCounts(): { projections: number; claims: number } {
    const count = (table: string): number => Number(this.#get(`SELECT COUNT(*) AS n FROM ${table}`)?.['n'] ?? 0);
    return { projections: count('projections'), claims: count('claims') };
  }

  // ── blobs ─────────────────────────────────────────────────────────────────────────────────────

  insertBlob(ref: BlobRef): void {
    this.#stmt('INSERT OR IGNORE INTO blobs (sha256, size) VALUES (?, ?)').run(ref.sha256, ref.size);
  }

  // ── maintenance ───────────────────────────────────────────────────────────────────────────────

  counts(): IndexCounts {
    const count = (table: string): number => Number(this.#get(`SELECT COUNT(*) AS n FROM ${table}`)?.['n'] ?? 0);
    return { runs: count('runs'), checkpoints: count('checkpoints'), events: count('events') };
  }

  /** Drop every indexed row (reindex rebuilds them). */
  clearAll(): void {
    for (const table of ['runs', 'events', 'checkpoints', 'blobs', 'file_cache', 'projections', 'claims']) {
      this.#stmt(`DELETE FROM ${table}`).run();
    }
  }

  /** The change-detection cache of one run. */
  fileCache(runId: string): FileCache {
    return {
      get: (relPath) => {
        const row = this.#get('SELECT * FROM file_cache WHERE run_id = ? AND path = ?', runId, relPath);
        if (row === undefined) return undefined;
        const entry: FileCacheEntry = {
          path: String(row['path']),
          size: Number(row['size']),
          mtimeNs: String(row['mtime_ns']),
          inode: String(row['inode']),
          sha256: String(row['sha256']),
          hashedAtNs: String(row['hashed_at_ns']),
        };
        return entry;
      },
      set: (entry) => {
        this.#stmt(
          `INSERT OR REPLACE INTO file_cache (run_id, path, size, mtime_ns, inode, sha256, hashed_at_ns) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(runId, entry.path, entry.size, entry.mtimeNs, entry.inode, entry.sha256, entry.hashedAtNs);
      },
      delete: (relPath) => {
        this.#stmt('DELETE FROM file_cache WHERE run_id = ? AND path = ?').run(runId, relPath);
      },
      paths: () => this.#all('SELECT path FROM file_cache WHERE run_id = ? ORDER BY path', runId).map((row) => String(row['path'])),
    };
  }
}
