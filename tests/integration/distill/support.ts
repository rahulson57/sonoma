/**
 * Distiller integration fixture: a throwaway git repo (tests/helpers/tmpRepo.ts) with a real LocalBackend
 * store, one run, and recorded providers (tests/helpers/providerStub.ts). No network. Everything lives
 * under the OS temp dir.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BlobProjectionStore,
  createBudget,
  storageSource,
  type DistillBudget,
  type DistillDeps,
  type DistillerProvider,
} from '../../../src/distill/index.js';
import type { Checkpoint, JsonPayload, LedgerEvent, LedgerEventType } from '../../../src/model/types.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { fixedClock, type FixedClock } from '../../helpers/clock.js';
import { recordedProvider, type ProviderRecording, type RecordedProvider } from '../../helpers/providerStub.js';
import { tmpGitRepo } from '../../helpers/tmpRepo.js';

const execFileAsync = promisify(execFile);

export const START_MS = Date.UTC(2026, 8, 13, 9, 0, 0);
export const RECORDED_USAGE = { inputTokens: 900, outputTokens: 80, costUsd: 0.0013 } as const;

export interface DistillFixture {
  readonly backend: LocalBackend;
  readonly runId: string;
  readonly clock: FixedClock;
  /** Projection store over the backend's CAS. */
  readonly store: BlobProjectionStore;
  append(type: LedgerEventType, payload: JsonPayload): Promise<LedgerEvent>;
  /** A checkpoint whose sanitized staging tree holds `files` (on top of earlier calls' files). */
  checkpoint(parent: Checkpoint | null, files: Record<string, string>, label?: string | null): Promise<Checkpoint>;
  /** A recorded provider replaying `replies`, one per complete() call. */
  provider(model: string, replies: readonly string[]): Promise<RecordedProvider>;
  deps(provider: DistillerProvider, budget?: DistillBudget): DistillDeps;
  git(args: readonly string[]): Promise<string>;
  close(): Promise<void>;
}

export async function openFixture(): Promise<DistillFixture> {
  const repo = await tmpGitRepo({ files: { 'README.md': 'distill fixture\n' } });
  const scratch = await mkdtemp(path.join(await realpath(os.tmpdir()), 'ckpt-distill-'));
  const staging = path.join(scratch, 'staging');
  await mkdir(staging);
  const clock = fixedClock(START_MS);
  let backend: LocalBackend | undefined;
  const close = async (): Promise<void> => {
    await backend?.close();
    await rm(scratch, { recursive: true, force: true });
    await repo.cleanup();
  };
  try {
    backend = await LocalBackend.open({ repoDir: repo.dir, clock });
    const opened = backend;
    const run = await opened.createRun({ agent: 'claude-code' });
    const store = new BlobProjectionStore(opened);
    let recordings = 0;

    return {
      backend: opened,
      runId: run.run_id,
      clock,
      store,
      append: (type, payload) => opened.appendEvent(run.run_id, { type, actor: 'runtime', payload }),
      async checkpoint(parent, files, label = null) {
        for (const [rel, content] of Object.entries(files)) {
          const target = path.join(staging, rel);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        clock.tick(1000);
        return opened.createCheckpoint({
          run_id: run.run_id,
          parent_checkpoint_id: parent?.checkpoint_id ?? null,
          label,
          pending_intent: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          stagingDir: staging,
        });
      },
      async provider(model, replies) {
        const recording: ProviderRecording = {
          provider: 'anthropic',
          model,
          responses: replies.map((text) => ({ text, usage: { ...RECORDED_USAGE } })),
        };
        const file = path.join(scratch, `recording-${++recordings}.json`);
        await writeFile(file, JSON.stringify(recording));
        return recordedProvider(file);
      },
      deps: (provider, budget) => ({
        provider,
        source: storageSource(opened, run.run_id),
        store,
        budget: budget ?? createBudget(run.run_id),
        clock,
      }),
      async git(args) {
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
        const { stdout } = await execFileAsync('git', [...args], { cwd: repo.dir, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' } });
        return stdout;
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Wraps a provider and counts its complete() calls. */
export function countingProvider(inner: DistillerProvider): DistillerProvider & { readonly calls: number } {
  let calls = 0;
  return {
    name: inner.name,
    model: inner.model,
    get calls() {
      return calls;
    },
    complete(prompt: string) {
      calls += 1;
      return inner.complete(prompt);
    },
  };
}
