/** `ckpt export` and `ckpt import` (SPEC-011 through the Export/Import service). */
import path from 'node:path';
import { EXPORT_CONFIRMATION, EXPORT_PROMPT, UNSAFE_CONFIRMATION, UNSAFE_EXPORT_PROMPT } from '../../bundle/index.js';
import type { InvocationOf } from '../args.js';
import { EXIT_ABORTED, EXIT_OK, type ExitCode } from '../errors.js';
import type { CliIo } from '../io.js';
import type { CliModules } from '../modules.js';
import { renderImport, renderScanReport } from '../render.js';

/**
 * Two-stage export: planExport scans and reports, the user confirms, and only then does writeBundle write. A safe export
 * proceeds only on exactly `y`. An `--unsafe` export proceeds only on exactly `EXPORT UNSAFE`. Any other answer, including
 * end of input, writes nothing and exits 3.
 */
export async function exportBundle(invocation: InvocationOf<'export'>, modules: CliModules, io: CliIo): Promise<ExitCode> {
  const { manifest, report } = await modules.bundle.planExport(invocation.target, { unsafe: invocation.unsafe });
  const unsafe = invocation.unsafe || manifest.unsafe;
  io.stdout(renderScanReport(report, unsafe));

  const answer = (await io.prompt(unsafe ? UNSAFE_EXPORT_PROMPT : EXPORT_PROMPT)).replace(/\r$/, '');
  if (answer !== (unsafe ? UNSAFE_CONFIRMATION : EXPORT_CONFIRMATION)) {
    io.stderr(unsafe ? `Aborted: the confirmation was not exactly ${UNSAFE_CONFIRMATION}. Bundle NOT written.\n` : 'Aborted. Bundle NOT written.\n');
    return EXIT_ABORTED;
  }

  const bundlePath = await modules.bundle.writeBundle(manifest, unsafe ? { confirmed: true, unsafeConfirmation: answer } : { confirmed: true });
  io.stdout(`Bundle written: ${bundlePath}\n`);
  return EXIT_OK;
}

export async function importBundle(invocation: InvocationOf<'import'>, modules: CliModules, io: CliIo): Promise<ExitCode> {
  const { runIds } = await modules.bundle.importBundle(path.resolve(io.cwd, invocation.bundlePath));
  io.stdout(renderImport(runIds));
  return EXIT_OK;
}
