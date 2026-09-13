/**
 * The durable execution ledger of one run: `.ckpt/runs/<run_id>/events.jsonl`.
 *
 * One sealed LedgerEvent per line, as canonical JSON, appended and fsynced before the append is
 * acknowledged. This file (not checkpoint.db) is the source of truth reindex rebuilds from. A line
 * without its terminating newline is a torn write from a crash: it was never acknowledged, so readers
 * ignore it and a writer truncates it before appending.
 */
import { open, readFile } from 'node:fs/promises';
import { canonicalJSON } from '../ledger/canonical-json.js';
import type { LedgerEvent } from '../model/types.js';
import { validateEvent } from '../model/validate.js';
import { StorageError } from './errors.js';
import { appendDurable, errnoCode } from './fs-util.js';

export interface EventLog {
  readonly events: LedgerEvent[];
  /** Bytes of complete lines. */
  readonly validBytes: number;
  /** Bytes of a torn final line (0 when the file ends cleanly). */
  readonly tornBytes: number;
}

export async function appendEventLine(file: string, event: LedgerEvent): Promise<void> {
  await appendDurable(file, `${canonicalJSON(event)}\n`);
}

export async function readEventLog(file: string, runId: string): Promise<EventLog> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { events: [], validBytes: 0, tornBytes: 0 };
    throw err;
  }
  const validBytes = bytes.lastIndexOf(0x0a) + 1;
  const events: LedgerEvent[] = [];
  const lines = bytes.subarray(0, validBytes).toString('utf8').split('\n');
  lines.forEach((line, index) => {
    if (line === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new StorageError('ERR_CORRUPT', `${file}:${index + 1} is not JSON`, { cause: err });
    }
    const valid = validateEvent(parsed);
    if (!valid.ok) throw new StorageError('ERR_CORRUPT', `${file}:${index + 1} is not a ledger event: ${valid.errors.join('; ')}`);
    if (valid.value.run_id !== runId) {
      throw new StorageError('ERR_CORRUPT', `${file}:${index + 1} belongs to ${valid.value.run_id}, not ${runId}`);
    }
    events.push(valid.value);
  });
  return { events, validBytes, tornBytes: bytes.byteLength - validBytes };
}

/** Drop a torn tail so the next append starts on a line boundary. */
export async function truncateEventLog(file: string, validBytes: number): Promise<void> {
  const handle = await open(file, 'r+');
  try {
    await handle.truncate(validBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
