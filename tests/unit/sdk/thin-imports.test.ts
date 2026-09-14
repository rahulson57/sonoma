/**
 * SPEC-010 "Must never import any module other than the Engine's public types": src/sdk/** imports nothing from
 * src/storage, src/redact, node:fs, child_process, better-sqlite3 or any HTTP client.
 *
 * The rule enforced here is the strict form of that sentence:
 * - relative imports inside src/sdk are free;
 * - outside src/sdk, only a whole-statement `import type` / `export type` from the Engine's public type surface
 *   (src/engine/index.ts, and src/model/types.ts, whose types that surface is written in) is allowed; it is erased
 *   at compile time, so the SDK bundle carries no Engine, storage or git code;
 * - src/storage and src/redact may not be named at all, not even for types;
 * - no bare or `node:` module, no non-literal dynamic import or require, no global network API.
 *
 * The scanner itself is tested against sources that break each rule, so an empty result proves something.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SDK_DIR = path.join(REPO_ROOT, 'src', 'sdk');

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/** The Engine's public types. Only a type-only statement may name them. */
const TYPE_ONLY_ALLOWED: ReadonlySet<string> = new Set(['src/engine/index.ts', 'src/model/types.ts']);

/** Never importable, not even as types. */
const FORBIDDEN_DIRS = ['src/storage', 'src/redact'];

/** Named classes, for a precise message. Every other bare module is refused too. */
const FORBIDDEN_MODULE_CLASSES: ReadonlyArray<{ readonly test: RegExp; readonly what: string }> = [
  { test: /^(node:)?fs(\/promises)?$/, what: 'the filesystem (node:fs)' },
  { test: /^(node:)?child_process$/, what: 'child_process' },
  { test: /^better-sqlite3$/, what: 'better-sqlite3' },
  {
    test: /^((node:)?(http|https|http2|net|tls|dgram|dns)|undici|axios|node-fetch|got|ky|superagent|ws|@anthropic-ai\/sdk)(\/.*)?$/,
    what: 'an HTTP/network client',
  },
];

const GLOBAL_NETWORK_APIS: ReadonlyArray<{ readonly test: RegExp; readonly what: string }> = [
  { test: /\bfetch\s*\(/, what: 'global fetch()' },
  { test: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { test: /\bWebSocket\b/, what: 'WebSocket' },
  { test: /\bcreateRequire\b/, what: 'createRequire (an unscannable require)' },
  { test: /\bprocess\s*\.\s*(binding|dlopen)\b/, what: 'process.binding/dlopen' },
];

/** Removes // and block comments, keeping string and template literals intact. */
export function stripComments(source: string): string {
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
  readonly typeOnly: boolean;
}

/** Every module a source names: static import/export-from, side-effect import, dynamic import(), require(). */
function moduleReferences(code: string): { refs: ModuleReference[]; opaque: string[] } {
  const refs: ModuleReference[] = [];
  const opaque: string[] = [];
  const fromClause = /\b(?:import|export)\s+(type\s+)?[\w*${}\s,]*?\bfrom\s*(['"])([^'"]+)\2/g;
  for (const m of code.matchAll(fromClause)) refs.push({ specifier: m[3] ?? '', typeOnly: m[1] !== undefined });
  const sideEffect = /\bimport\s*(['"])([^'"]+)\1/g;
  for (const m of code.matchAll(sideEffect)) refs.push({ specifier: m[2] ?? '', typeOnly: false });
  const call = /\b(import|require)\s*\(\s*/g;
  for (const m of code.matchAll(call)) {
    const rest = code.slice((m.index ?? 0) + m[0].length);
    const literal = /^(['"`])([^'"`$]+)\1\s*\)/.exec(rest);
    if (literal === null) opaque.push(`${m[1]}(…) with a non-literal module name`);
    else refs.push({ specifier: literal[2] ?? '', typeOnly: false });
  }
  return { refs, opaque };
}

/** Repo-relative POSIX path of a relative specifier, `.js` mapped back to its `.ts` source. */
function resolveRelative(fromFile: string, specifier: string): string {
  let abs = path.resolve(path.dirname(fromFile), specifier);
  if (abs.endsWith('.js')) abs = `${abs.slice(0, -3)}.ts`;
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/** Every thin-import violation in one source file (empty when it complies). */
export function scanSource(file: string, source: string): string[] {
  const code = stripComments(source);
  const { refs, opaque } = moduleReferences(code);
  const violations = [...opaque];
  for (const { specifier, typeOnly } of refs) {
    if (!specifier.startsWith('.')) {
      const named = FORBIDDEN_MODULE_CLASSES.find((c) => c.test.test(specifier));
      violations.push(`${specifier}: ${named ? `imports ${named.what}` : 'a package import; only the Engine public types may be imported'}`);
      continue;
    }
    const target = resolveRelative(file, specifier);
    if (target === 'src/sdk' || target.startsWith('src/sdk/')) continue;
    if (FORBIDDEN_DIRS.some((dir) => target === dir || target.startsWith(`${dir}/`))) {
      violations.push(`${specifier}: imports from ${target}, which SPEC-010 forbids`);
    } else if (!TYPE_ONLY_ALLOWED.has(target)) {
      violations.push(`${specifier}: ${target} is not the Engine's public type surface`);
    } else if (!typeOnly) {
      violations.push(`${specifier}: ${target} may only be named in a whole-statement \`import type\``);
    }
  }
  for (const api of GLOBAL_NETWORK_APIS) {
    if (api.test.test(code)) violations.push(`uses ${api.what}`);
  }
  return violations;
}

async function sdkSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sdkSourceFiles(abs)));
    else out.push(abs);
  }
  return out.sort();
}

describe('src/sdk thin imports (SPEC-010)', () => {
  it('src/sdk holds only scannable source files, and at least one', async () => {
    const files = await sdkSourceFiles(SDK_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !SOURCE_EXTENSIONS.has(path.extname(f)))).toEqual([]);
  });

  it('imports nothing from src/storage, src/redact, node:fs, child_process, better-sqlite3 or any HTTP client, and only Engine public types outside src/sdk', async () => {
    const violations: string[] = [];
    for (const file of await sdkSourceFiles(SDK_DIR)) {
      const rel = path.relative(REPO_ROOT, file);
      for (const v of scanSource(file, await readFile(file, 'utf8'))) violations.push(`${rel}: ${v}`);
    }
    expect(violations).toEqual([]);
  });

  describe('the scanner flags what the rule forbids', () => {
    const probe = path.join(SDK_DIR, 'probe.ts');
    it.each([
      ['better-sqlite3', "import Database from 'better-sqlite3';"],
      ['node:fs', "import { readFile } from 'node:fs/promises';"],
      ['bare fs', "import * as fs from 'fs';"],
      ['child_process', "import { execFile } from 'node:child_process';"],
      ['https', "import https from 'node:https';"],
      ['an HTTP client package', "import axios from 'axios';"],
      ['src/redact at runtime', "import { sanitize } from '../redact/index.js';"],
      ['src/storage even as a type', "import type { StorageBackend } from '../storage/types.js';"],
      ['a runtime Engine import', "import { CheckpointEngine } from '../engine/index.js';"],
      ['an inline type specifier (not whole-statement)', "import { type CheckpointRef } from '../engine/index.js';"],
      ['an engine internal', "import type { RunView } from '../engine/engine.js';"],
      ['a re-export from storage', "export { LocalBackend } from '../storage/index.js';"],
      ['a side-effect import', "import 'node:http';"],
      ['a literal dynamic import', "const cp = await import('node:child_process');"],
      ['a non-literal dynamic import', 'const m = await import(name);'],
      ['require()', "const https = require('https');"],
      ['global fetch()', "await fetch('http://127.0.0.1');"],
      ['a multi-line import', "import {\n  readFile,\n  writeFile,\n} from 'node:fs/promises';"],
    ])('%s', (_name, source) => {
      expect(scanSource(probe, source)).not.toEqual([]);
    });

    it('allows sdk-relative imports, whole-statement type imports of the Engine surface, and forbidden names in comments', () => {
      const source = [
        "import { CkptValidationError } from './errors.js';",
        "import type { CheckpointEngine, CheckpointRef } from '../engine/index.js';",
        "export type { SemanticClaim } from '../model/types.js';",
        "// never: import { readFile } from 'node:fs';",
        "/* nor: const db = require('better-sqlite3'); fetch('x') */",
        "const note = 'see src/storage';",
      ].join('\n');
      expect(scanSource(probe, source)).toEqual([]);
    });
  });
});
