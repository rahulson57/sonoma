/**
 * Loads `schema/*.json` into a SchemaRegistry.
 *
 * The schema files are the runtime contract (SPEC-004 file scope `schema/**`). They are read from
 * disk rather than imported, so the same code works from `src/` (tsx, vitest) and from `dist/src/`
 * (tsc build): the loader walks up from this module until it finds `schema/`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry, type SchemaValidation } from './json-schema.js';

export const SCHEMA_BASE_URI = 'https://ckpt.local/schema/';

/** Every file under schema/. tests/unit/model/schema.test.ts asserts nothing else is there. */
export const SCHEMA_FILES = {
  common: 'common.schema.json',
  checkpoint: 'checkpoint.schema.json',
  ledgerEvent: 'ledger-event.schema.json',
  semanticClaim: 'semantic-claim.schema.json',
  semanticProjection: 'semantic-projection.schema.json',
  agentState: 'agent-state.schema.json',
  sideEffect: 'side-effect.schema.json',
} as const;

export type SchemaName = keyof typeof SCHEMA_FILES;

export function schemaDir(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (;;) {
    const candidate = join(dir, 'schema');
    if (existsSync(join(candidate, SCHEMA_FILES.ledgerEvent))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`ckpt: cannot locate the schema/ directory above ${here}`);
    dir = parent;
  }
}

let registry: SchemaRegistry | undefined;

/** The process-wide registry holding every ckpt schema (loaded once, on first use). */
export function schemaRegistry(): SchemaRegistry {
  if (registry) return registry;
  const dir = schemaDir();
  const loaded = new SchemaRegistry();
  for (const file of Object.values(SCHEMA_FILES)) {
    const id = loaded.add(JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown);
    if (id !== SCHEMA_BASE_URI + file) {
      throw new Error(`ckpt: ${file} must declare "$id": "${SCHEMA_BASE_URI + file}", found ${id}`);
    }
  }
  registry = loaded;
  return loaded;
}

export function schemaId(name: SchemaName): string {
  return SCHEMA_BASE_URI + SCHEMA_FILES[name];
}

export function validateAgainst(name: SchemaName, value: unknown): SchemaValidation {
  return schemaRegistry().validate(schemaId(name), value);
}
