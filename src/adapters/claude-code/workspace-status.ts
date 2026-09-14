/**
 * Workspace status for SPEC-009's "workspace.changed when the tool is Write/Edit/Bash and `git status` differs".
 *
 * "Differs" means: differs from the status observed at that tool call's PreToolUse (Q-026 default 4). The adapter has
 * no store, so the before-status travels in the ledger itself, as `workspace_status` on the tool.requested
 * observation. It is carried as a 16-hex digest: a status digest is not secret, and at 16 characters it is below the
 * scanner's 20-character high-entropy floor, so the engine's sanitize pass leaves it byte-identical and the
 * PostToolUse digest compares equal when nothing changed.
 *
 * `git --no-optional-locks status` never refreshes or writes the index, so observing never writes the user's
 * repository. The store directory (`.ckpt/`) is excluded, since the engine writes it while the session runs.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { STORE_DIR_NAME } from '../../storage/layout.js';

export const WORKSPACE_STATUS_DIGEST_LENGTH = 16;

/** Most status entries a workspace.changed observation lists. */
export const MAX_STATUS_ENTRIES = 1000;

export interface StatusEntry {
  /** Porcelain v1 XY code, e.g. ` M`, `??`, `R `. */
  readonly status: string;
  readonly path: string;
  /** Source path of a rename or copy. */
  readonly oldPath?: string;
}

export interface WorkspaceStatus {
  readonly digest: string;
  readonly entries: readonly StatusEntry[];
  /** True when more than MAX_STATUS_ENTRIES entries existed. */
  readonly truncated: boolean;
}

export type ReadWorkspaceStatus = (workspaceDir: string) => Promise<WorkspaceStatus>;

export function statusDigest(porcelain: Uint8Array): string {
  return createHash('sha256').update(porcelain).digest('hex').slice(0, WORKSPACE_STATUS_DIGEST_LENGTH);
}

/** Parse `git status --porcelain=v1 -z`: `XY path\0`, with a rename/copy's source path as the following token. */
export function parsePorcelainZ(porcelain: Uint8Array): { entries: StatusEntry[]; truncated: boolean } {
  const tokens = Buffer.from(porcelain.buffer, porcelain.byteOffset, porcelain.byteLength).toString('utf8').split('\0');
  const entries: StatusEntry[] = [];
  let total = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    const entry: StatusEntry =
      status.startsWith('R') || status.startsWith('C')
        ? { status, path: token.slice(3), oldPath: tokens[++i] ?? '' }
        : { status, path: token.slice(3) };
    total += 1;
    if (entries.length < MAX_STATUS_ENTRIES) entries.push(entry);
  }
  return { entries, truncated: total > MAX_STATUS_ENTRIES };
}

export function workspaceStatusOf(porcelain: Uint8Array): WorkspaceStatus {
  return { digest: statusDigest(porcelain), ...parsePorcelainZ(porcelain) };
}

/**
 * The environment git runs with: inherited GIT_* variables are dropped, so a stray GIT_DIR / GIT_INDEX_FILE /
 * GIT_WORK_TREE (set by an enclosing git hook, for instance) cannot point the status at another repository or index.
 */
function statusEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_OPTIONAL_LOCKS: '0' };
}

/** `git status` of `workspaceDir` (which must be inside a git worktree), excluding the ckpt store. */
export const readWorkspaceStatus: ReadWorkspaceStatus = (workspaceDir) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.', `:(exclude)${STORE_DIR_NAME}`],
      {
        cwd: workspaceDir,
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
        env: statusEnv(),
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(workspaceStatusOf(stdout));
      },
    );
  });
