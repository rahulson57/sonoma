/**
 * Export/Import service (SPEC-011 "Interfaces"): planExport, writeBundle and importBundle over one Local
 * Storage store, plus exportBundle, the two-stage flow with its confirmation gates. The CLI (a later
 * slice) prints the report and prompt and passes the user's answer in; this module never reads a
 * terminal.
 *
 * Gates, enforced here rather than left to callers:
 * - writeBundle writes only with `{confirmed: true}`, and only a manifest this service's planExport
 *   produced (kept in a WeakMap). The manifest is frozen, so a planned safe export cannot be turned
 *   unsafe after the scan.
 * - An unsafe plan is written only with the exact confirmation `EXPORT UNSAFE`. The choice is appended
 *   to the run's ledger BEFORE any bundle byte is written, so no unsafe bundle exists without its record.
 * - exportBundle proceeds only on exactly `y` (or exactly `EXPORT UNSAFE` for an unsafe export). Any
 *   other answer aborts with no bundle file.
 */
import path from 'node:path';
import type { JsonPayload } from '../model/types.js';
import { BlobStore } from '../storage/cas.js';
import type { LocalBackend } from '../storage/local-backend.js';
import { BundleError } from './errors.js';
import { planExport, writePlannedBundle, type BundleContext, type ExportPlan, type ExportTarget } from './export.js';
import { BundleGit } from './git.js';
import { importBundle } from './import.js';
import {
  BUNDLE_FILE_NAME,
  EXPORT_CONFIRMATION,
  UNSAFE_CONFIRMATION,
  UNSAFE_EXPORT_EVENT_TYPE,
  type BundleManifest,
  type BundleResult,
  type BundleScanReport,
  type ExportOptions,
} from './types.js';

/** SPEC-011 export flow step 3. */
export const EXPORT_PROMPT = 'Bundle NOT written. Proceed? [y/N]';
export const UNSAFE_EXPORT_PROMPT = `Bundle NOT written. --unsafe writes it WITHOUT redaction. Type ${UNSAFE_CONFIRMATION} to proceed:`;

export interface BundleServiceOptions {
  /** The store to export from and import into. */
  readonly backend: LocalBackend;
  /** Directory for a bundle written without an explicit outPath. Defaults to the process cwd. */
  readonly outDir?: string;
}

export interface WriteBundleOptions {
  readonly confirmed: true;
  /** Destination file. Defaults to `<outDir>/checkpoint.bundle`. Never overwritten. */
  readonly outPath?: string;
  /** Required, exactly `EXPORT UNSAFE`, when the plan is unsafe. */
  readonly unsafeConfirmation?: string;
}

export interface ConfirmRequest {
  readonly report: BundleScanReport;
  readonly unsafe: boolean;
  readonly prompt: string;
}

export interface ExportIo {
  /** Show the report and prompt; resolve with the user's answer, verbatim. */
  confirm(request: ConfirmRequest): Promise<string>;
  readonly outPath?: string;
}

export class BundleService {
  readonly #backend: LocalBackend;
  readonly #outDir: string;
  readonly #plans = new WeakMap<BundleManifest, ExportPlan>();
  #context: Promise<BundleContext> | undefined;

  constructor(options: BundleServiceOptions) {
    this.#backend = options.backend;
    this.#outDir = options.outDir ?? process.cwd();
  }

  #ctx(): Promise<BundleContext> {
    this.#context ??= (async () => {
      const layout = this.#backend.layout;
      return { layout, blobs: new BlobStore(layout.objects, layout.tmp), git: await BundleGit.open(path.dirname(layout.root)) };
    })().catch((err: unknown) => {
      this.#context = undefined;
      throw err;
    });
    return this.#context;
  }

  /** Stages 1–2: enumerate and scan. Writes nothing. */
  async planExport(target: ExportTarget, opts: ExportOptions = {}): Promise<{ manifest: BundleManifest; report: BundleScanReport }> {
    const plan = await planExport(await this.#ctx(), target, opts);
    this.#plans.set(plan.manifest, plan);
    return { manifest: plan.manifest, report: plan.report };
  }

  /** Stage 4: write a planned bundle after confirmation. Returns the bundle path. */
  async writeBundle(manifest: BundleManifest, options: WriteBundleOptions): Promise<string> {
    if (typeof options !== 'object' || options === null || options.confirmed !== true) {
      throw new BundleError('ERR_NOT_CONFIRMED', 'writeBundle writes only after explicit confirmation ({confirmed: true})');
    }
    const plan = this.#plans.get(manifest);
    if (plan === undefined) {
      throw new BundleError('ERR_UNKNOWN_PLAN', 'this manifest was not produced by planExport on this service, or was already written');
    }
    if (plan.unsafe && options.unsafeConfirmation !== UNSAFE_CONFIRMATION) {
      throw new BundleError('ERR_UNSAFE_NOT_CONFIRMED', `an unsafe bundle is written only after the exact confirmation ${JSON.stringify(UNSAFE_CONFIRMATION)}`);
    }
    this.#plans.delete(manifest);
    const ctx = await this.#ctx();
    if (plan.unsafe) await this.#recordUnsafeExport(plan);
    return writePlannedBundle(ctx, plan, path.resolve(options.outPath ?? path.join(this.#outDir, BUNDLE_FILE_NAME)));
  }

  /** The two-stage export: plan and scan, ask, then write or abort. */
  async exportBundle(target: ExportTarget, opts: ExportOptions, io: ExportIo): Promise<BundleResult> {
    const { manifest, report } = await this.planExport(target, opts);
    const answer = await io.confirm({ report, unsafe: manifest.unsafe, prompt: manifest.unsafe ? UNSAFE_EXPORT_PROMPT : EXPORT_PROMPT });
    const proceed = manifest.unsafe ? answer === UNSAFE_CONFIRMATION : answer === EXPORT_CONFIRMATION;
    if (!proceed) {
      this.#plans.delete(manifest);
      return { status: 'aborted', report };
    }
    const bundlePath = await this.writeBundle(manifest, {
      confirmed: true,
      ...(io.outPath === undefined ? {} : { outPath: io.outPath }),
      ...(manifest.unsafe ? { unsafeConfirmation: answer } : {}),
    });
    return { status: 'written', bundlePath, report };
  }

  /** SPEC-011 importBundle. */
  async importBundle(bundlePath: string): Promise<{ runIds: string[] }> {
    return importBundle(await this.#ctx(), this.#backend, bundlePath);
  }

  async #recordUnsafeExport(plan: ExportPlan): Promise<void> {
    const payload: JsonPayload = {
      confirmation: UNSAFE_CONFIRMATION,
      run_ids: [...plan.manifest.runIds],
      checkpoint_ids: [...plan.manifest.checkpointIds],
      blob_count: plan.manifest.blobRefs.length,
      git_ref_count: plan.manifest.gitRefs.length,
      redaction_hits_bypassed: plan.report.hits.length,
    };
    await this.#backend.appendEvent(plan.runId, { type: UNSAFE_EXPORT_EVENT_TYPE, actor: 'human', payload });
  }
}

export function createBundleService(options: BundleServiceOptions): BundleService {
  return new BundleService(options);
}
