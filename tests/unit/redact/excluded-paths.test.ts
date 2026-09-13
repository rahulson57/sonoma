import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isExcludedPath } from '../../../src/redact/index.js';
import { tmpGitRepo, type TmpGitRepo } from '../../helpers/tmpRepo.js';

const execFileAsync = promisify(execFile);

/** Never let an inherited GIT_DIR / GIT_INDEX_FILE point git at another repository. */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

describe('isExcludedPath — SPEC-003 hard-excluded secret paths', () => {
  it.each(['.env', '.env.local', 'credentials.json', 'id.pem', 'server.key'])('excludes %s', (relPath) => {
    expect(isExcludedPath(relPath)).toBe(true);
  });

  it.each([
    ['config/.env.production', 'nested .env*'],
    ['./.env', 'leading ./'],
    ['deploy/certs/id.pem', 'nested *.pem'],
    ['app\\secrets\\server.key', 'Windows separators'],
    ['.ENV', 'upper-case .env'],
    ['Credentials.JSON', 'mixed-case credentials*'],
    ['credentials', 'bare credentials file'],
    ['.env.d/extra.conf', 'file inside a .env* directory'],
    ['home/.aws/credentials/default', 'file inside a credentials* directory'],
  ])('excludes %s (%s)', (relPath) => {
    expect(isExcludedPath(relPath)).toBe(true);
  });

  it.each(['build/out.js', 'src/environment.ts', 'src/keys.ts', 'docs/pem-format.md', 'README.md', '.gitignore', ''])(
    'does not exclude %j',
    (relPath) => {
      expect(isExcludedPath(relPath)).toBe(false);
    },
  );
});

describe('isExcludedPath — .gitignore is not a secret policy', () => {
  let repo: TmpGitRepo;

  beforeAll(async () => {
    repo = await tmpGitRepo({
      files: { '.gitignore': 'build/\n', 'build/out.js': 'export {};\n', 'src/index.js': 'export {};\n' },
    });
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it('does not exclude a gitignored build/out.js', async () => {
    // Precondition: git really ignores it here (`check-ignore -q` exits 0 for an ignored path).
    await expect(
      execFileAsync('git', ['check-ignore', '-q', 'build/out.js'], { cwd: repo.dir, env: isolatedGitEnv() }),
    ).resolves.toBeDefined();
    expect(isExcludedPath('build/out.js')).toBe(false);
  });

  it('excludes .env even though git does not ignore it', async () => {
    // `check-ignore -q` exits 1 for a path that is not ignored.
    await expect(
      execFileAsync('git', ['check-ignore', '-q', '.env'], { cwd: repo.dir, env: isolatedGitEnv() }),
    ).rejects.toMatchObject({ code: 1 });
    expect(isExcludedPath('.env')).toBe(true);
  });
});
