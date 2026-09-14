/**
 * Shared fixtures for the Local Inspector UI tests (SPEC-012).
 *
 * A fixture store is WRITTEN through its own LocalBackend and CheckpointEngine, and both are closed before any
 * inspector opens the store. The inspector gets a separate backend and engine and only reads through them, the way
 * `ckpt ui` reads a store. Repositories live under the OS temp dir (tests/helpers/tmpRepo.ts); time comes from
 * tests/helpers/clock.ts.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CheckpointEngine, type CheckpointRef } from '../../../src/engine/index.js';
import type { Checkpoint, LedgerEvent, LedgerEventDraft, Run } from '../../../src/model/types.js';
import { LocalBackend } from '../../../src/storage/index.js';
import { readRunRecords, startInspector, type InspectorHandle } from '../../../src/ui/index.js';
import { fixedClock } from '../../helpers/clock.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

const execFileAsync = promisify(execFile);

export const START_MS = Date.UTC(2026, 0, 1);
export const HEX64 = /^[0-9a-f]{64}$/;
/** A well-formed run id no fixture ever creates. */
export const UNKNOWN_RUN_ID = `run_${'0'.repeat(26)}`;

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function refText(checkpoint: Checkpoint): string {
  return `${checkpoint.run_id}:${checkpoint.checkpoint_id}`;
}

export function engineRef(checkpoint: Checkpoint): CheckpointRef {
  return { runId: checkpoint.run_id, checkpointId: checkpoint.checkpoint_id };
}

export function checkpointPath(checkpoint: Checkpoint): string {
  return `/api/checkpoints/${encodeURIComponent(refText(checkpoint))}`;
}

export function diffPath(a: Checkpoint, b: Checkpoint): string {
  return `/api/diff?a=${encodeURIComponent(refText(a))}&b=${encodeURIComponent(refText(b))}`;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export interface FixtureOptions {
  /** Observations recorded inside c2's ledger range, after the fixture's own. */
  readonly c2Observations?: (runId: string) => LedgerEventDraft[];
  /** Label of c2 (default `edited`). */
  readonly c2Label?: string;
}

export interface ForkFixture {
  readonly repo: TmpGitRepo;
  readonly source: Run;
  readonly forked: Run;
  readonly c1: Checkpoint;
  readonly c2: Checkpoint;
  readonly c3: Checkpoint;
  readonly f1: Checkpoint;
  readonly f2: Checkpoint;
  /** The sealed events of `c2Observations`, in order. */
  readonly c2Extra: readonly LedgerEvent[];
  cleanup(): Promise<void>;
}

/**
 * The source run `c1 → c2 → c3`, and a run forked from c2 with `f1 → f2`.
 * - c1: the initial workspace (a.txt), a model call and a Read tool call.
 * - c2 (labelled): a.txt edited, an Edit tool call, an irreversible side effect, a model request, then `c2Observations`.
 * - c3: c.txt added.
 * - f1: the fork's first checkpoint, on c2's tree. f2: b.txt added in the fork's worktree.
 * The clock advances 1 s between checkpoints, so createdAt orders them c1, c2, c3, f1, f2.
 */
export async function buildForkFixture(options: FixtureOptions = {}): Promise<ForkFixture> {
  const repo = await tmpGitRepo({ files: { 'a.txt': 'one\n' } });
  try {
    const clock = fixedClock(START_MS);
    const writer = await LocalBackend.open({ repoDir: repo.dir, clock });
    try {
      const engine = await CheckpointEngine.open({ backend: writer, repoDir: repo.dir });
      const source = await engine.startRun({ agent: 'claude-code' });
      const id = source.run_id;

      await engine.record([
        { run_id: id, type: 'model.requested', actor: 'runtime', payload: { model: 'fixture-model' } },
        { run_id: id, type: 'model.responded', actor: 'runtime', payload: { usage: { input_tokens: 10, output_tokens: 5 } } },
        { run_id: id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_read', tool_name: 'Read', input: { path: 'a.txt' } } },
        { run_id: id, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_read', output: 'one' } },
      ]);
      const c1 = await engine.checkpoint(id);

      clock.tick(1000);
      await writeFiles(repo.dir, { 'a.txt': 'two\n' });
      await engine.record([
        { run_id: id, type: 'tool.requested', actor: 'agent', payload: { tool_call_id: 'call_edit', tool_name: 'Edit', input: { path: 'a.txt' } } },
        { run_id: id, type: 'tool.completed', actor: 'runtime', payload: { tool_call_id: 'call_edit', output: 'ok' } },
        { run_id: id, type: 'side_effect.requested', actor: 'agent', payload: { side_effect_id: 'se_mail', type: 'email.send', target: 'ops@example.invalid' } },
        { run_id: id, type: 'side_effect.committed', actor: 'runtime', payload: { side_effect_id: 'se_mail', status: 'sent' } },
        { run_id: id, type: 'model.requested', actor: 'runtime', payload: { model: 'fixture-model' } },
      ]);
      const c2Extra = await engine.record(options.c2Observations?.(id) ?? []);
      const c2 = await engine.checkpoint(id, { label: options.c2Label ?? 'edited' });

      clock.tick(1000);
      await writeFiles(repo.dir, { 'c.txt': 'three\n' });
      const c3 = await engine.checkpoint(id);

      clock.tick(1000);
      const forked = await engine.fork(engineRef(c2));
      const f1 = await engine.checkpoint(forked.run_id);

      clock.tick(1000);
      await writeFiles(engine.worktreePath(forked.run_id), { 'b.txt': 'fork only\n' });
      const f2 = await engine.checkpoint(forked.run_id);

      return { repo, source, forked, c1, c2, c3, f1, f2, c2Extra, cleanup: () => repo.cleanup() };
    } finally {
      await writer.close();
    }
  } catch (err) {
    await repo.cleanup();
    throw err;
  }
}

/** GET paths that must answer 200: the page, its assets, and every endpoint over every fixture checkpoint. */
export function everyGetPath(fx: ForkFixture): string[] {
  const checkpoints = [fx.c1, fx.c2, fx.c3, fx.f1, fx.f2];
  const diffs: Array<[Checkpoint, Checkpoint]> = [
    [fx.c1, fx.c2],
    [fx.c2, fx.c3],
    [fx.c3, fx.f2],
    [fx.f2, fx.c1],
    [fx.f1, fx.f1],
  ];
  return [
    '/',
    '/app.js',
    '/app.css',
    '/api/runs',
    `/api/runs/${fx.source.run_id}/checkpoints`,
    `/api/runs/${fx.forked.run_id}/checkpoints`,
    ...checkpoints.map(checkpointPath),
    ...diffs.map(([a, b]) => diffPath(a, b)),
  ];
}

/** GET paths naming something that does not exist: each must answer 404 with {error}. */
export function missingPaths(fx: ForkFixture): string[] {
  return [
    `/api/runs/${UNKNOWN_RUN_ID}/checkpoints`,
    '/api/runs/not-a-run/checkpoints',
    `/api/checkpoints/${encodeURIComponent(`${fx.source.run_id}:c_99`)}`,
    `/api/checkpoints/${encodeURIComponent(`${UNKNOWN_RUN_ID}:c_1`)}`,
    '/api/checkpoints/c_1',
    `/api/diff?a=${encodeURIComponent(refText(fx.c1))}&b=${encodeURIComponent(`${UNKNOWN_RUN_ID}:c_1`)}`,
  ];
}

/** One route per /api endpoint. */
export function apiRoutes(fx: ForkFixture): string[] {
  return ['/api/runs', `/api/runs/${fx.source.run_id}/checkpoints`, checkpointPath(fx.c2), diffPath(fx.c1, fx.f2)];
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

export interface InspectorFixture {
  readonly backend: LocalBackend;
  readonly engine: CheckpointEngine;
  readonly inspector: InspectorHandle;
  request(pathName: string, init?: RequestInit): Promise<HttpResult>;
  close(): Promise<void>;
}

/** An inspector on a free loopback port over the store of `repoDir`, with its own read backend and engine. */
export async function openInspector(repoDir: string): Promise<InspectorFixture> {
  const backend = await LocalBackend.open({ repoDir });
  try {
    const engine = await CheckpointEngine.open({ backend, repoDir });
    const inspector = await startInspector({ port: 0, backend, engine, listRuns: () => readRunRecords(backend.layout.runs) });
    return {
      backend,
      engine,
      inspector,
      async request(pathName, init) {
        const res = await fetch(new URL(pathName, inspector.url), init);
        const text = await res.text();
        let json: unknown;
        try {
          json = text === '' ? undefined : JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { status: res.status, headers: res.headers, text, json };
      },
      async close() {
        try {
          await inspector.close();
        } finally {
          await backend.close();
        }
      },
    };
  } catch (err) {
    await backend.close();
    throw err;
  }
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
}

async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(abs)));
    else if (entry.isFile()) files.push(abs);
  }
  return files.sort();
}

/**
 * sha256 of every durable artifact the inspector must never change: the SQLite index file, every CAS object, every
 * run record and ledger file, and refs/checkpoints/* (loose ref files, packed-refs, and the resolved ref list).
 */
export async function storeSnapshot(repoDir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const store = path.join(repoDir, '.ckpt');
  snapshot['.ckpt/checkpoint.db'] = sha256(await readFile(path.join(store, 'checkpoint.db')));
  for (const dir of [path.join(store, 'objects'), path.join(store, 'runs'), path.join(repoDir, '.git', 'refs', 'checkpoints')]) {
    for (const file of await filesUnder(dir)) snapshot[path.relative(repoDir, file)] = sha256(await readFile(file));
  }
  snapshot['.git/packed-refs'] = sha256(await readFile(path.join(repoDir, '.git', 'packed-refs')).catch(() => Buffer.alloc(0)));
  const { stdout } = await execFileAsync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/checkpoints/'], {
    cwd: repoDir,
    env: isolatedGitEnv(),
  });
  snapshot['refs/checkpoints/*'] = stdout;
  return snapshot;
}
