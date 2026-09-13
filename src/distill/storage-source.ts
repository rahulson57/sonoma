/** DistillSource over a StorageBackend: one run's state, events, blobs and checkpoints. Read-only. */
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { sha256Hex } from '../ledger/hash.js';
import { isStorageError } from '../storage/errors.js';
import type { StorageBackend } from '../storage/types.js';
import { DistillError } from './errors.js';
import type { DistillSource } from './types.js';

export type DistillStorage = Pick<StorageBackend, 'getCheckpoint' | 'getState' | 'getEvents' | 'getBlob'>;

async function bytesOf(stream: Readable): Promise<Uint8Array> {
  return buffer(stream);
}

export function storageSource(storage: DistillStorage, runId: string): DistillSource {
  return {
    runId,

    async readState(checkpointId) {
      const ref = { run_id: runId, checkpoint_id: checkpointId };
      const checkpoint = await storage.getCheckpoint(ref);
      // The hash of the bytes actually stored, not just the one the checkpoint record claims.
      const stateHash = sha256Hex(await bytesOf(await storage.getBlob(checkpoint.state_blob)));
      if (stateHash !== checkpoint.state_hash) {
        throw new DistillError('DISTILL_INPUT_MISMATCH', `state blob of ${runId}/${checkpointId} hashes to ${stateHash}, not ${checkpoint.state_hash}`);
      }
      return { stateHash, state: await storage.getState(ref) };
    },

    async readEvents(range) {
      if (range.fromSeq > range.toSeq) return [];
      return storage.getEvents(runId, { fromSeq: range.fromSeq, toSeq: range.toSeq });
    },

    async readBlob(ref) {
      return bytesOf(await storage.getBlob(ref));
    },

    async hasCheckpoint(checkpointId) {
      try {
        await storage.getCheckpoint({ run_id: runId, checkpoint_id: checkpointId });
        return true;
      } catch (err) {
        if (isStorageError(err, 'ERR_NOT_FOUND') || isStorageError(err, 'ERR_INVALID_INPUT')) return false;
        throw err;
      }
    },
  };
}
