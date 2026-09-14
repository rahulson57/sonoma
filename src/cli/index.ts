/**
 * CLI Surface (SPEC-013) public surface. The Anthropic provider is deliberately not re-exported: only `ckpt distill`
 * loads it, through a dynamic import.
 */
export { main } from './main.js';
export { COMMANDS, parseArgs, usageText, type CommandName, type Invocation, type InvocationOf, type RefCommand, type RefInvocation } from './args.js';
export { API_KEY_ENV, anthropicProviderFromEnv, defaultDeps, withModules, type CliDeps } from './deps.js';
export { localRunner, openLocalModules, storageClaims, type CliDistiller, type CliEngine, type CliInspector, type CliModules, type CliStorage } from './modules.js';
export { processIo, type CliIo } from './io.js';
export { CliError, EXIT_ABORTED, EXIT_OK, EXIT_RUNTIME_ERROR, EXIT_USAGE, UsageError, type ExitCode } from './errors.js';
