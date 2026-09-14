/**
 * SPEC-013 "Must never" and DEC-065, enforced on the source of src/cli/**:
 * - no import of better-sqlite3;
 * - from src/storage, only the public surface src/storage/index.ts, and from it only the backend the CLI opens plus
 *   contract types and id patterns. The storage internals (git plumbing, SQLite index, CAS, locks) are never named,
 *   directly or through the surface;
 * - no HTTP or network client module (node:http, node:https, http2, net, tls, dgram, undici, axios, node-fetch, got, ky,
 *   superagent, ws, cross-fetch, isomorphic-fetch, request) and no global network API (fetch(), XMLHttpRequest,
 *   WebSocket);
 * - @anthropic-ai/sdk is an LLM provider SDK, not an HTTP client (DEC-065). Exactly one file imports it:
 *   src/cli/providers/anthropic.ts;
 * - no module reference the scan cannot read (a non-literal import() or require(), createRequire).
 * The scanner itself is tested against sources that break each rule, so an empty result proves something.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_DIR = path.join(REPO_ROOT, 'src', 'cli');
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/** The one file allowed to import the provider SDK. */
const SDK_IMPORTER = 'src/cli/providers/anthropic.ts';

/** The storage module's public surface, and the only names the CLI may take from it. */
const STORAGE_SURFACE = 'src/storage/index.ts';
const STORAGE_NAMES: ReadonlySet<string> = new Set([
  'LocalBackend',
  'StorageBackend',
  'CheckpointRef',
  'ReindexCounts',
  'RUN_ID_PATTERN',
  'CHECKPOINT_ID_PATTERN',
  'StorageError',
  'isStorageError',
]);

const SQLITE = /^better-sqlite3(\/.*)?$/;
const HTTP_CLIENT = /^((node:)?(http|https|http2|net|tls|dgram)|undici|axios|node-fetch|got|ky|superagent|ws|cross-fetch|isomorphic-fetch|request)(\/.*)?$/;
const PROVIDER_SDK = /^@anthropic-ai\/sdk(\/.*)?$/;

const GLOBAL_APIS: ReadonlyArray<{ readonly test: RegExp; readonly what: string }> = [
  { test: /\bfetch\s*\(/, what: 'global fetch()' },
  { test: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { test: /\bWebSocket\b/, what: 'WebSocket' },
  { test: /\bcreateRequire\b/, what: 'createRequire (an unscannable require)' },
  { test: /\bprocess\s*\.\s*(binding|dlopen)\b/, what: 'process.binding/dlopen' },
];

/** Removes // and block comments, keeping string and template literals intact. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      out += source.slice(start, i);
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

interface ModuleReference {
  readonly specifier: string;
  /** The import/export clause (`{ A, type B }`, `X`, `* as ns`, `*`); null for a side-effect import, import() or require(). */
  readonly clause: string | null;
}

/** Every module a source names: static import/export-from, side-effect import, dynamic import(), require(). */
function moduleReferences(code: string): { refs: ModuleReference[]; opaque: string[] } {
  const refs: ModuleReference[] = [];
  const opaque: string[] = [];
  const fromClause = /\b(?:import|export)\s+((?:type\s+)?[\w*${}\s,]*?)\s*\bfrom\s*(['"])([^'"]+)\2/g;
  for (const m of code.matchAll(fromClause)) refs.push({ specifier: m[3] ?? '', clause: m[1] ?? '' });
  const sideEffect = /\bimport\s*(['"])([^'"]+)\1/g;
  for (const m of code.matchAll(sideEffect)) refs.push({ specifier: m[2] ?? '', clause: null });
  const call = /\b(import|require)\s*\(\s*/g;
  for (const m of code.matchAll(call)) {
    const rest = code.slice((m.index ?? 0) + m[0].length);
    const literal = /^(['"`])([^'"`$]+)\1\s*\)/.exec(rest);
    if (literal === null) opaque.push(`${m[1]}(…) with a non-literal module name`);
    else refs.push({ specifier: literal[2] ?? '', clause: null });
  }
  return { refs, opaque };
}

/** The names a clause binds, and whether it takes the whole module (default, `* as ns`, `export *`). */
function importedNames(clause: string): { names: string[]; wholeModule: boolean } {
  const body = clause.replace(/^type\s+/, '');
  const braces = /\{([^}]*)\}/.exec(body);
  const outside = body.replace(/\{[^}]*\}/, '').replace(/[\s,]/g, '');
  const names = (braces?.[1] ?? '')
    .split(',')
    .map((part) => (part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '').trim())
    .filter((name) => name !== '');
  return { names, wholeModule: outside !== '' };
}

function repoPath(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/** Repo-relative POSIX path of a relative specifier, `.js` mapped back to its `.ts` source. */
function resolveRelative(fromFile: string, specifier: string): string {
  const abs = path.resolve(path.dirname(fromFile), specifier);
  return repoPath(abs.endsWith('.js') ? `${abs.slice(0, -3)}.ts` : abs);
}

function storageViolations(specifier: string, target: string, clause: string | null): string[] {
  if (target !== STORAGE_SURFACE) return [`${specifier}: ${target} is a src/storage internal`];
  if (clause === null) return [`${specifier}: a whole-module import of src/storage`];
  const { names, wholeModule } = importedNames(clause);
  if (wholeModule) return [`${specifier}: a default, namespace or star import of src/storage`];
  return names.filter((name) => !STORAGE_NAMES.has(name)).map((name) => `${specifier}: ${name} is not part of the storage surface the CLI may use`);
}

function referenceViolations(file: string, { specifier, clause }: ModuleReference): string[] {
  if (SQLITE.test(specifier)) return [`${specifier}: imports better-sqlite3`];
  if (HTTP_CLIENT.test(specifier)) return [`${specifier}: imports an HTTP/network client`];
  if (PROVIDER_SDK.test(specifier)) return repoPath(file) === SDK_IMPORTER ? [] : [`${specifier}: only ${SDK_IMPORTER} may import the provider SDK`];
  if (!specifier.startsWith('.')) return [];
  const target = resolveRelative(file, specifier);
  return target === 'src/storage' || target.startsWith('src/storage/') ? storageViolations(specifier, target, clause) : [];
}

/** Every thin-import violation in one source file (empty when it complies). */
function scanSource(file: string, source: string): string[] {
  const code = stripComments(source);
  const { refs, opaque } = moduleReferences(code);
  const violations = [...opaque, ...refs.flatMap((ref) => referenceViolations(file, ref))];
  for (const api of GLOBAL_APIS) {
    if (api.test.test(code)) violations.push(`uses ${api.what}`);
  }
  return violations;
}

function importsSdk(source: string): boolean {
  return moduleReferences(stripComments(source)).refs.some((ref) => PROVIDER_SDK.test(ref.specifier));
}

async function cliSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await cliSourceFiles(abs)));
    else out.push(abs);
  }
  return out.sort();
}

describe('src/cli thin imports (SPEC-013, DEC-065)', () => {
  it('src/cli holds only scannable source files, and at least one', async () => {
    const files = await cliSourceFiles(CLI_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !SOURCE_EXTENSIONS.has(path.extname(file)))).toEqual([]);
  });

  it('imports nothing from better-sqlite3, the git plumbing in src/storage internals, or any HTTP client, and calls no global network API', async () => {
    const violations: string[] = [];
    for (const file of await cliSourceFiles(CLI_DIR)) {
      for (const violation of scanSource(file, await readFile(file, 'utf8'))) violations.push(`${repoPath(file)}: ${violation}`);
    }
    expect(violations).toEqual([]);
  });

  it(`@anthropic-ai/sdk is imported by exactly one file, ${SDK_IMPORTER}`, async () => {
    const importers: string[] = [];
    for (const file of await cliSourceFiles(CLI_DIR)) {
      if (importsSdk(await readFile(file, 'utf8'))) importers.push(repoPath(file));
    }
    expect(importers).toEqual([SDK_IMPORTER]);
  });

  describe('the scanner flags what the rule forbids', () => {
    const probe = path.join(CLI_DIR, 'probe.ts');
    it.each([
      ['better-sqlite3', "import Database from 'better-sqlite3';"],
      ['the storage git plumbing', "import { GitRepo } from '../storage/git.js';"],
      ['the SQLite index', "import type { IndexDb } from '../storage/index-db.js';"],
      ['a storage internal re-exported by the surface', "import { GitRepo, LocalBackend } from '../storage/index.js';"],
      ['a re-export of storage internals', "export { collectStagingTree } from '../storage/index.js';"],
      ['a namespace import of storage', "import * as storage from '../storage/index.js';"],
      ['a star re-export of storage', "export * from '../storage/index.js';"],
      ['a side-effect import of a storage internal', "import '../storage/cas.js';"],
      ['a multi-line storage import naming an internal', "import {\n  LocalBackend,\n  BlobStore,\n} from '../storage/index.js';"],
      ['node:https', "import https from 'node:https';"],
      ['bare http', "import http from 'http';"],
      ['undici', "import { request } from 'undici';"],
      ['axios', "import axios from 'axios';"],
      ['node-fetch', "import nodeFetch from 'node-fetch';"],
      ['a literal dynamic import of node:http', "const http = await import('node:http');"],
      ['require of https', "const https = require('https');"],
      ['a non-literal dynamic import', 'const m = await import(name);'],
      ['global fetch()', "await fetch('https://api.example.invalid/v1');"],
      ['globalThis.fetch()', "await globalThis.fetch('https://api.example.invalid/v1');"],
      ['XMLHttpRequest', 'const xhr = new XMLHttpRequest();'],
      ['the provider SDK outside its one file', "import Anthropic from '@anthropic-ai/sdk';"],
      ['a dynamic import of the provider SDK outside its one file', "const sdk = await import('@anthropic-ai/sdk');"],
    ])('%s', (_name, source) => {
      expect(scanSource(probe, source)).not.toEqual([]);
    });

    it('allows the storage surface names, other modules, node built-ins, the provider file by relative import, and forbidden names in comments', () => {
      const source = [
        "import { LocalBackend, RUN_ID_PATTERN, type StorageBackend } from '../storage/index.js';",
        "import type { ReindexCounts } from '../storage/index.js';",
        "import { CheckpointEngine } from '../engine/index.js';",
        "import { startInspector } from '../ui/index.js';",
        "import { createInterface } from 'node:readline';",
        "const provider = await import('./providers/anthropic.js');",
        "// never: import Database from 'better-sqlite3'; await fetch('x');",
        "/* nor: import { GitRepo } from '../storage/git.js'; */",
      ].join('\n');
      expect(scanSource(probe, source)).toEqual([]);
    });

    it(`allows the provider SDK in ${SDK_IMPORTER} only`, () => {
      const source = "import Anthropic from '@anthropic-ai/sdk';";
      expect(scanSource(path.join(REPO_ROOT, SDK_IMPORTER), source)).toEqual([]);
      expect(scanSource(path.join(CLI_DIR, 'providers', 'other.ts'), source)).not.toEqual([]);
    });
  });
});
