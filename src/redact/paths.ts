/**
 * Secret-path exclusion policy (SPEC-003 "Path exclusion", DEC-007).
 *
 * Hard-excluded, whatever any other policy says: `.env*`, `credentials*`, `*.pem`, `*.key`.
 * The globs are matched against EVERY segment of the path, case-insensitively, so a file inside
 * a `credentials/` directory or a `.env.d/` directory is excluded too, and `.ENV` on a
 * case-insensitive filesystem is not a way around the rule. Over-excluding is the acceptable
 * failure; letting a secret file through is not.
 *
 * `.gitignore` is deliberately NOT consulted: it is not a secret policy. Ignored paths follow a
 * separate, configurable snapshot policy that lives with the caller.
 */
const EXCLUDED_SEGMENT_RULES: ReadonlyArray<(segment: string) => boolean> = [
  (segment) => segment.startsWith('.env'),
  (segment) => segment.startsWith('credentials'),
  (segment) => segment.endsWith('.pem'),
  (segment) => segment.endsWith('.key'),
];

/**
 * True when `relPath` (workspace-relative; `/` or `\` separators) names a secret path that must
 * never be snapshotted, committed, stored or exported.
 */
export function isExcludedPath(relPath: string): boolean {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => {
      const lower = segment.toLowerCase();
      return EXCLUDED_SEGMENT_RULES.some((rule) => rule(lower));
    });
}
