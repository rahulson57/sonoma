/**
 * `npm run bench:check` entry point. SPEC-001 fixes the script as
 * `tsx bench/check.ts bench/results.json`. The budget logic is SPEC-002's
 * bench/check-budgets.ts; this file only forwards to it.
 */
import { main } from './check-budgets.js';

process.exitCode = main(process.argv.slice(2));
