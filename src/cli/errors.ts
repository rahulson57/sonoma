/** Exit codes and error classes of the `ckpt` CLI (SPEC-013 "Exit codes"). */

/** Success. A rollback that printed side-effect warnings still exits 0. */
export const EXIT_OK = 0;
/** Runtime error: a module rejected, the store could not be opened, a required credential is missing. */
export const EXIT_RUNTIME_ERROR = 1;
/** Usage error: unknown command, missing or extra argument, unknown flag, malformed id. */
export const EXIT_USAGE = 2;
/** The user declined a confirmation. */
export const EXIT_ABORTED = 3;

export type ExitCode = number;

/** Thrown by argument parsing; main() prints it with the usage text on stderr and exits 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** A runtime failure the CLI detects itself rather than a module reporting it (exit 1). */
export class CliError extends Error {
  override readonly name = 'CliError';
}

function errorCode(err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code !== '' ? code : null;
}

/** `CODE: message` (or just the message) for a thrown value. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = errorCode(err);
  return code === null || err.message.startsWith(code) ? err.message : `${code}: ${err.message}`;
}

/** The error's code or class name only, never its message: for paths where a message could echo payload bytes. */
export function errorKind(err: unknown): string {
  return errorCode(err) ?? (err instanceof Error ? err.name : typeof err);
}
