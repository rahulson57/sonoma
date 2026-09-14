#!/usr/bin/env node
/** The `ckpt` executable (SPEC-013). All behaviour lives in src/cli; this only turns main()'s result into the exit code. */
import { main } from '../src/cli/index.js';

process.exitCode = await main(process.argv.slice(2));
