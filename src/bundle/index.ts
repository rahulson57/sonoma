/** Export/Import (SPEC-011) public surface. */
export {
  BundleService,
  EXPORT_PROMPT,
  UNSAFE_EXPORT_PROMPT,
  createBundleService,
  type BundleServiceOptions,
  type ConfirmRequest,
  type ExportIo,
  type WriteBundleOptions,
} from './service.js';
export type { ExportTarget } from './export.js';
export { BundleError, isBundleError, type BundleErrorCode } from './errors.js';
export { BundleFormatError } from './tar.js';
export {
  BUNDLE_FILE_MODE,
  BUNDLE_FILE_NAME,
  BUNDLE_SCHEMA_VERSION,
  EXPORT_CONFIRMATION,
  UNSAFE_CONFIRMATION,
  UNSAFE_EXPORT_EVENT_TYPE,
  type BundleManifest,
  type BundleResult,
  type BundleScanReport,
  type BundleStatus,
  type ExportOptions,
} from './types.js';
