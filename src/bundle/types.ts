/**
 * Export/Import bundle contract types (SPEC-011 "Contract").
 */
import type { LedgerEventType } from '../ledger/event-types.js';
import type { RedactionHit } from '../redact/index.js';

export const BUNDLE_SCHEMA_VERSION = 1;

/** SPEC-011 `bundleFile`: the default file name of a written bundle. */
export const BUNDLE_FILE_NAME = 'checkpoint.bundle';

/** SPEC-011 `bundleFile`: file mode 0600. */
export const BUNDLE_FILE_MODE = 0o600;

/**
 * Ledger event type that records an unsafe export.
 *
 * INTERIM (DEC-023): SPEC-011 names this event `bundle.exported_unsafe`, but the landed SPEC-004 enum
 * (src/ledger/event-types.ts) has `export.unsafe` and the ledger rejects unknown types. The type is
 * defined only here, and every use and test references this constant, so whichever way the pending
 * SPEC-011/SPEC-004 amendment goes, the fix is one line. `satisfies` makes a rename in SPEC-004 fail
 * typecheck here rather than at runtime.
 */
export const UNSAFE_EXPORT_EVENT_TYPE = 'export.unsafe' as const satisfies LedgerEventType;

/** SPEC-011 `--unsafe`: the exact text the user must type. Anything else aborts. */
export const UNSAFE_CONFIRMATION = 'EXPORT UNSAFE';

/** SPEC-011 export flow step 3: the only answer that proceeds. Anything else aborts. */
export const EXPORT_CONFIRMATION = 'y';

export interface BundleManifest {
  schemaVersion: number;
  runIds: string[];
  checkpointIds: string[];
  /** `sha256:<hex>` */
  blobRefs: string[];
  /** refs/checkpoints/* only. */
  gitRefs: { ref: string; sha: string }[];
  unsafe: boolean;
}

/** SPEC-011 `bundleScanReport`. */
export interface BundleScanReport {
  filesScanned: number;
  toolOutputs: number;
  envEntries: number;
  hits: RedactionHit[];
}

/** SPEC-011 `bundleCommand` export options. Defaults: include everything, `unsafe = false`. */
export interface ExportOptions {
  includeWorkspace?: boolean;
  includeLedger?: boolean;
  includeArtifacts?: boolean;
  unsafe?: boolean;
}

export type BundleStatus = 'written' | 'aborted' | 'imported';

/** SPEC-011 `bundleResult`. */
export interface BundleResult {
  status: BundleStatus;
  bundlePath?: string;
  report: BundleScanReport;
  importedRunIds?: string[];
}
