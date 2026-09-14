/**
 * What main() needs from outside itself, and the real implementations. Tests override any member of CliDeps, so every
 * module call a command makes goes through a seam they can observe.
 */
import type { Runner } from '../adapters/claude-code/index.js';
import type { DistillerProvider } from '../distill/index.js';
import { CliError } from './errors.js';
import { processIo, type CliIo } from './io.js';
import { localRunner, openLocalModules, type CliModules } from './modules.js';

/** The credential `ckpt distill` needs for the Anthropic provider (DEC-065). */
export const API_KEY_ENV = 'ANTHROPIC_API_KEY';

export interface CliDeps {
  readonly io: CliIo;
  /** Opens the store for a command that reads or changes it. */
  openModules(io: CliIo): Promise<CliModules>;
  /** The Claude Code Adapter's runner for `ckpt run claude`. It opens and closes the store itself. */
  createRunner(io: CliIo): Pick<Runner, 'run'>;
  /** The Distiller provider. Only `ckpt distill` calls this, and it does so before opening the store. */
  createProvider(io: CliIo): Promise<DistillerProvider>;
  /** Resolves when `ckpt ui` should stop serving. */
  untilShutdown(): Promise<void>;
}

/**
 * The Anthropic provider, loaded with a dynamic import so no other command loads the SDK. With no API key it fails
 * before any client exists, so no request can be attempted.
 */
export async function anthropicProviderFromEnv(io: CliIo): Promise<DistillerProvider> {
  const apiKey = io.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new CliError(`${API_KEY_ENV} is not set. \`ckpt distill\` calls the Anthropic API and needs a key; no request was made.`);
  }
  const { createAnthropicProvider } = await import('./providers/anthropic.js');
  return createAnthropicProvider({ apiKey });
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

export function defaultDeps(): CliDeps {
  return {
    io: processIo(),
    openModules: openLocalModules,
    createRunner: localRunner,
    createProvider: anthropicProviderFromEnv,
    untilShutdown: untilSignal,
  };
}

/** Runs `use` with the store open, and closes the store whether or not `use` succeeds. */
export async function withModules<T>(deps: CliDeps, use: (modules: CliModules) => Promise<T>): Promise<T> {
  const modules = await deps.openModules(deps.io);
  let result: T;
  try {
    result = await use(modules);
  } catch (err) {
    await modules.close().catch(() => undefined);
    throw err;
  }
  await modules.close();
  return result;
}
