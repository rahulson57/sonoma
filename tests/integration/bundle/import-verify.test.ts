/**
 * SPEC-011 "Import" beyond the hash chain and content addresses: what a re-sealed ledger or a padded
 * bundle can fake. Nothing in a ledger is signed, so anyone holding a bundle can edit it and recompute the
 * chain. Import must still refuse a ref at a non-commit, a git object of the wrong type anywhere below a
 * ref, and a state blob of the wrong size, and must format-check every git object before writing any. It
 * writes only what the imported runs use, and a failed import never deletes a shared CAS blob.
 */
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import type { BundleContext } from '../../../src/bundle/export.js';
import { BundleGit, encodeGitObject, gitObjectId } from '../../../src/bundle/git.js';
import { importBundle } from '../../../src/bundle/import.js';
import { BundleError, isBundleError, type BundleErrorCode } from '../../../src/bundle/index.js';
import { casEntry, gitObjectEntry } from '../../../src/bundle/layout.js';
import { canonicalJSON } from '../../../src/ledger/canonical-json.js';
import type { BlobRef, Checkpoint } from '../../../src/model/types.js';
import { BlobStore } from '../../../src/storage/index.js';
import {
  answering,
  checkpoint,
  editManifest,
  git,
  openStore,
  readBundle,
  resealedLedger,
  rewrittenCopy,
  seedCleanRun,
  sha256,
  storeState,
  type Store,
} from '../../unit/bundle/fixtures.js';

const IDENTITY = 'Bundle Test <bundle-test@example.com> 1767225600 +0000';

function commitObject(tree: string, parents: readonly string[] = []): Buffer {
  const lines = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${IDENTITY}`, `committer ${IDENTITY}`, '', 'planted checkpoint', ''];
  return encodeGitObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

function treeObject(mode: string, name: string, sha: string): Buffer {
  return encodeGitObject('tree', Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), Buffer.from(sha, 'hex')]));
}

describe('import verification of re-sealed and padded bundles', () => {
  let source: Store;
  let bundlePath: string;
  let runId: string;
  let checkpoints: Checkpoint[];
  let destination: Store;
  let own: Checkpoint;
  let variants = 0;

  beforeAll(async () => {
    source = await openStore();
    ({ runId, checkpoints } = await seedCleanRun(source));
    bundlePath = (await source.service.exportBundle(runId, {}, answering('y'))).bundlePath!;
  });

  afterAll(async () => {
    await source.cleanup();
  });

  beforeEach(async () => {
    destination = await openStore();
    const run = await destination.backend.createRun({ agent: 'sdk' });
    own = await checkpoint(destination, run.run_id, null, { 'own.txt': 'destination content\n' });
  });

  afterEach(async () => {
    await destination.cleanup();
  });

  function variantPath(name: string): string {
    variants += 1;
    return path.join(source.outDir, `${name}-${variants}.bundle`);
  }

  function ledgerName(): string {
    return `runs/${runId}/events.jsonl`;
  }

  async function expectRejectedWithoutWrites(variant: string, code: BundleErrorCode, pattern: RegExp): Promise<void> {
    const before = await storeState(destination);
    await expect(destination.service.importBundle(variant)).rejects.toSatisfy((err) => isBundleError(err, code) && pattern.test(String((err as Error).message)));
    expect(await storeState(destination)).toEqual(before);
    expect(before.runs).not.toContain(runId);
  }

  /**
   * A copy of the bundle, with `objects` added as git objects, in which c_1 points at `target`. Its state
   * blob, checkpoint record, ref and manifest all agree on `target`, and the chain is re-sealed, so only
   * checks the chain cannot provide stand between it and the store.
   */
  async function repointedCopy(name: string, target: string, objects: readonly Buffer[] = []): Promise<string> {
    const first = checkpoints[0]!;
    const variant = variantPath(name);
    await rewrittenCopy(bundlePath, variant, (edited) => {
      for (const object of objects) edited.set(gitObjectEntry(gitObjectId(object)), object);
      const state = JSON.parse(edited.get(casEntry(first.state_blob.sha256))!.toString('utf8')) as Record<string, unknown>;
      const stateBytes = Buffer.from(canonicalJSON({ ...state, workspace_commit: target }), 'utf8');
      const stateRef: BlobRef = { sha256: sha256(stateBytes), size: stateBytes.byteLength };
      edited.delete(casEntry(first.state_blob.sha256));
      edited.set(casEntry(stateRef.sha256), stateBytes);
      edited.set(
        ledgerName(),
        resealedLedger(edited.get(ledgerName())!, (events) => {
          const created = events.find((e) => e['type'] === 'checkpoint.created' && e['payload']['checkpoint_id'] === first.checkpoint_id)!;
          Object.assign(created['payload'], { workspace_commit: target, state_blob: stateRef, state_hash: stateRef.sha256 });
        }),
      );
      const ref = `refs/checkpoints/${runId}/${first.checkpoint_id}`;
      edited.set(ref, Buffer.from(`${target}\n`, 'latin1'));
      editManifest(edited, (manifest) => ({
        ...manifest,
        blobRefs: manifest.blobRefs.map((blobRef) => (blobRef === `sha256:${first.state_blob.sha256}` ? `sha256:${stateRef.sha256}` : blobRef)),
        gitRefs: manifest.gitRefs.map((gitRef) => (gitRef.ref === ref ? { ref, sha: target } : gitRef)),
      }));
    });
    return variant;
  }

  it.each(['already in this repository', 'carried by the bundle'] as const)('a re-sealed checkpoint whose ref points at a blob %s is rejected before any write', async (where) => {
    const target =
      where === 'already in this repository'
        ? (await git(destination.repo.dir, ['rev-parse', `${own.workspace_commit}:own.txt`])).trim()
        : gitObjectId([...(await readBundle(bundlePath))].find(([name, bytes]) => name.startsWith('git/objects/') && bytes.toString('latin1').startsWith('blob '))![1]);

    await expectRejectedWithoutWrites(await repointedCopy('ref-at-blob', target), 'ERR_INVALID_BUNDLE', /does not point at a commit/);
  });

  describe('git object types below the ref', () => {
    // Objects the bundle carries (c_1's workspace) and objects only the destination has (its own checkpoint).
    const sourceObject = async (spec: string): Promise<string> => (await git(source.repo.dir, ['rev-parse', spec])).trim();
    const destinationObject = async (spec: string): Promise<string> => (await git(destination.repo.dir, ['rev-parse', spec])).trim();

    it('a re-sealed checkpoint at a planted commit whose types are right imports (control for the cases below)', async () => {
      const tree = treeObject('40000', 'workspace', await sourceObject(`${checkpoints[0]!.workspace_commit}^{tree}`));
      const commit = commitObject(gitObjectId(tree), [await destinationObject(own.workspace_commit)]);

      expect(await destination.service.importBundle(await repointedCopy('well-typed', gitObjectId(commit), [tree, commit]))).toEqual({ runIds: [runId] });
      expect((await destination.backend.listCheckpoints(runId)).map((c) => c.workspace_commit)).toEqual([gitObjectId(commit), checkpoints[1]!.workspace_commit]);
      expect(await git(destination.repo.dir, ['fsck', '--no-dangling'])).toBe('');
    });

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly objects: () => Promise<Buffer[]>;
      readonly pattern: RegExp;
    }> = [
      {
        name: "a commit whose tree is a blob carried by the bundle",
        objects: async () => [commitObject(await sourceObject(`${checkpoints[0]!.workspace_commit}:README.md`))],
        pattern: /as a tree, but it is a blob/,
      },
      {
        name: 'a commit whose tree is a blob already in this repository',
        objects: async () => [commitObject(await destinationObject(`${own.workspace_commit}:own.txt`))],
        pattern: /as a tree, but it is a blob/,
      },
      {
        name: 'a tree whose regular-file entry is a tree',
        objects: async () => {
          const tree = treeObject('100644', 'file.txt', await sourceObject(`${checkpoints[0]!.workspace_commit}^{tree}`));
          return [tree, commitObject(gitObjectId(tree))];
        },
        pattern: /as a blob, but it is a tree/,
      },
      {
        name: 'a tree whose directory entry is a blob',
        objects: async () => {
          const tree = treeObject('40000', 'src', await sourceObject(`${checkpoints[0]!.workspace_commit}:README.md`));
          return [tree, commitObject(gitObjectId(tree))];
        },
        pattern: /as a tree, but it is a blob/,
      },
      {
        name: 'a commit whose parent is a blob carried by the bundle',
        objects: async () => [
          commitObject(await sourceObject(`${checkpoints[0]!.workspace_commit}^{tree}`), [await sourceObject(`${checkpoints[0]!.workspace_commit}:README.md`)]),
        ],
        pattern: /as a commit, but it is a blob/,
      },
      {
        name: 'a commit whose parent is a tree already in this repository',
        objects: async () => [commitObject(await sourceObject(`${checkpoints[0]!.workspace_commit}^{tree}`), [await destinationObject(`${own.workspace_commit}^{tree}`)])],
        pattern: /as a commit, but it is a tree/,
      },
      {
        // One object this repository already has (D), reached under two types. The walk pops the commit's
        // parent before its tree, so D's CORRECT expectation (commit) is recorded first and the wrong one (blob,
        // via the tree entry) second. That order is the point: it fails if only the first expected type of an
        // external object is kept. If the walk order ever changes, keep the correct reference first, or this
        // case silently becomes a duplicate of the "commit whose tree is a blob already in this repository" case.
        name: 'a tree whose regular-file entry is a commit already in this repository, which is also the parent',
        objects: async () => {
          const destinationCommit = await destinationObject(own.workspace_commit);
          const tree = treeObject('100644', 'file.txt', destinationCommit);
          return [tree, commitObject(gitObjectId(tree), [destinationCommit])];
        },
        pattern: /as a blob, but it is a commit/,
      },
    ];

    it.each(cases)('$name is rejected before any write', async ({ objects, pattern }) => {
      const planted = await objects();
      const commit = planted.at(-1)!;
      await expectRejectedWithoutWrites(await repointedCopy('wrong-type', gitObjectId(commit), planted), 'ERR_INVALID_BUNDLE', pattern);
      const present = await (await BundleGit.open(destination.repo.dir)).inspect(planted.map((object) => gitObjectId(object)));
      expect([...present].filter(([, info]) => info !== null)).toEqual([]);
    });
  });

  it('a re-sealed checkpoint whose state blob size differs from the bundled blob is rejected before any write', async () => {
    const second = checkpoints[1]!;
    const variant = variantPath('state-size');
    await rewrittenCopy(bundlePath, variant, (edited) => {
      edited.set(
        ledgerName(),
        resealedLedger(edited.get(ledgerName())!, (events) => {
          const created = events.find((e) => e['type'] === 'checkpoint.created' && e['payload']['checkpoint_id'] === second.checkpoint_id)!;
          created['payload']['state_blob'] = { ...created['payload']['state_blob'], size: second.state_blob.size + 1 };
        }),
      );
    });

    await expectRejectedWithoutWrites(variant, 'ERR_TAMPERED', new RegExp(`state blob of ${runId}/${second.checkpoint_id} is \\d+ bytes`));
  });

  it('a failed import never deletes a CAS blob, which another writer may reference by then', async () => {
    const layout = destination.backend.layout;
    const bundleGit = await BundleGit.open(destination.repo.dir);
    const ctx: BundleContext = { layout, blobs: new BlobStore(layout.objects, layout.tmp), git: bundleGit };
    const stateBytes = (await readBundle(bundlePath)).get(casEntry(checkpoints[0]!.state_blob.sha256))!;
    expect(await ctx.blobs.has(checkpoints[0]!.state_blob)).toBe(false);
    const before = await storeState(destination);

    let shared: BlobRef | undefined;
    bundleGit.createRefs = async () => {
      // After the import's put() and before its failure, another writer stores the same bytes. CAS
      // deduplicates, so that writer now references the file the import created.
      shared = await destination.backend.putBlob(stateBytes);
      throw new BundleError('ERR_GIT', 'injected ref transaction failure');
    };
    await expect(importBundle(ctx, destination.backend, bundlePath)).rejects.toSatisfy((err) => isBundleError(err, 'ERR_GIT'));

    expect(shared).toEqual(checkpoints[0]!.state_blob);
    expect(await ctx.blobs.read(shared!)).toEqual(stateBytes);
    // Everything else the import wrote is rolled back.
    const after = await storeState(destination);
    expect(after.runs).toEqual(before.runs);
    expect(after.refs).toEqual(before.refs);
  });

  it('a malformed git object is rejected before any git object is written', async () => {
    const entries = await readBundle(bundlePath);
    const blob = [...entries].find(([name, bytes]) => name.startsWith('git/objects/') && bytes.toString('latin1').startsWith('blob '))![1];
    // A tree entry with an empty file name: its id verifies, and only git's format check rejects it.
    const tree = encodeGitObject('tree', Buffer.concat([Buffer.from('100644 \0', 'latin1'), Buffer.from(gitObjectId(blob), 'hex')]));
    const variant = variantPath('malformed-tree');
    await rewrittenCopy(bundlePath, variant, (edited) => {
      edited.set(gitObjectEntry(gitObjectId(tree)), tree);
    });
    const commits = [...entries].filter(([name, bytes]) => name.startsWith('git/objects/') && bytes.toString('latin1').startsWith('commit ')).map(([, bytes]) => gitObjectId(bytes));
    expect(commits.length).toBe(checkpoints.length);

    await expectRejectedWithoutWrites(variant, 'ERR_INVALID_BUNDLE', /malformed/);
    const present = await (await BundleGit.open(destination.repo.dir)).inspect([...commits, gitObjectId(tree)]);
    expect([...present].filter(([, info]) => info !== null)).toEqual([]);
  });

  it('writes only the git objects its refs reach and the CAS blobs its runs reference', async () => {
    const strayObject = encodeGitObject('blob', Buffer.from('reachable from no ref\n', 'utf8'));
    const strayBlob = Buffer.from('referenced by no ledger or checkpoint\n', 'utf8');
    const strayRef: BlobRef = { sha256: sha256(strayBlob), size: strayBlob.byteLength };
    const variant = variantPath('stray-content');
    await rewrittenCopy(bundlePath, variant, (edited) => {
      edited.set(gitObjectEntry(gitObjectId(strayObject)), strayObject);
      edited.set(casEntry(strayRef.sha256), strayBlob);
      editManifest(edited, (manifest) => ({ ...manifest, blobRefs: [...manifest.blobRefs, `sha256:${strayRef.sha256}`] }));
    });

    expect(await destination.service.importBundle(variant)).toEqual({ runIds: [runId] });
    expect((await destination.backend.listCheckpoints(runId)).map((c) => c.checkpoint_id)).toEqual(checkpoints.map((c) => c.checkpoint_id));

    const present = await (await BundleGit.open(destination.repo.dir)).inspect([gitObjectId(strayObject), ...checkpoints.map((c) => c.workspace_commit)]);
    expect(present.get(gitObjectId(strayObject))).toBeNull();
    for (const c of checkpoints) expect(present.get(c.workspace_commit)?.type).toBe('commit');
    const blobs = new BlobStore(destination.backend.layout.objects, destination.backend.layout.tmp);
    expect(await blobs.has(strayRef)).toBe(false);
    for (const c of checkpoints) expect(await blobs.has(c.state_blob)).toBe(true);
  });
});
