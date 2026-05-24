#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — companion-runtime boundary (GM-19).
 *
 * Mechanically enforces the contract documented in
 * docs/governance/companion-runtime-boundary.md for src/companion/.
 * Tighter than the memory-module guard because the companion module
 * has NO direct DB access of any kind: no pg, no SQL, no FROM/JOIN.
 *
 * Fails the build on:
 *   1. Any forbidden SQL keyword in code: INSERT, UPDATE, DELETE,
 *      DROP, ALTER, TRUNCATE, GRANT, REVOKE, CREATE, SELECT, FROM,
 *      JOIN, WHERE. The companion module is library-level code over
 *      the memory module; raw SQL must never appear here.
 *   2. The identifier `insertPrivateMemory` appearing anywhere in
 *      code (defends against a future contributor calling the
 *      memory module's write op from the companion read path).
 *   3. An import of pg.
 *   4. An import of a model SDK (openai, anthropic, @anthropic-ai/sdk,
 *      @openai/*, @anthropic-ai/*).
 *   5. An import of an HTTP/server framework (http, https, express,
 *      fastify, koa, hapi). The companion module is library code; it
 *      must not mount endpoints.
 *   6. A memory-module import that reaches deeper than the package
 *      entry point. Only `../memory` and `../memory/index` are
 *      permitted; `../memory/repository`, `../memory/transaction`,
 *      `../memory/audit`, `../memory/client`, `../memory/errors` are
 *      forbidden.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source is
 * not scanned (it necessarily contains the keywords and identifiers
 * it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/companion'];

// All write + read SQL keywords. The companion module performs zero
// raw SQL — every memory access goes through src/memory's ctx
// helpers. Case-sensitive (only uppercase SQL keywords would slip in
// from a stray query string).
const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|SELECT|FROM|JOIN|WHERE)\b/g;

// CommonJS require() form.
const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const FORBIDDEN_MODULE_EXACT = new Set([
  'pg',
  'openai',
  'anthropic',
  '@anthropic-ai/sdk',
  'http',
  'https',
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
]);
const FORBIDDEN_MODULE_PREFIXES = ['@anthropic-ai/', '@openai/'];

// Memory-module imports are restricted to the package entry point.
// Anything matching ../memory/<deeper> is rejected.
const MEMORY_DEEP_RE = /^\.\.\/memory\/.+/;
const MEMORY_ENTRY_PATHS = new Set(['../memory', '../memory/index']);

// The single identifier whose presence in src/companion/ is a
// boundary violation. The reader's ctx exposes both
// listVisibleMemories and insertPrivateMemory; the companion module
// must structurally avoid calling the latter.
const FORBIDDEN_IDENTIFIER = /\binsertPrivateMemory\b/g;

function walk(rel, out) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
  } else if (rel.endsWith('.js')) {
    out.push(rel);
  }
}

function stripComments(content) {
  let out = content.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/.*$/gm, '');
  return out;
}

function isForbiddenModule(specifier) {
  if (FORBIDDEN_MODULE_EXACT.has(specifier)) return true;
  for (const prefix of FORBIDDEN_MODULE_PREFIXES) {
    if (specifier.startsWith(prefix)) return true;
  }
  return false;
}

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);

const errors = [];
for (const rel of files) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const code = stripComments(raw);

  // 1. No SQL keywords.
  const sqlMatches = code.match(FORBIDDEN_SQL);
  if (sqlMatches) {
    const unique = Array.from(new Set(sqlMatches)).sort();
    errors.push(`${rel}: forbidden SQL keyword(s) in code: ${unique.join(', ')}`);
  }

  // 2. No insertPrivateMemory identifier.
  if (FORBIDDEN_IDENTIFIER.test(code)) {
    errors.push(
      `${rel}: forbidden identifier "insertPrivateMemory" — the companion module is read-only`
    );
  }

  // 3, 4, 5, 6. Import discipline.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
    }
    if (MEMORY_DEEP_RE.test(specifier) && !MEMORY_ENTRY_PATHS.has(specifier)) {
      errors.push(
        `${rel}: memory-module import "${specifier}" reaches past the public entry — allowed: "../memory" or "../memory/index"`
      );
    }
  }
}

console.log('Baseline CI — companion boundary');
console.log('--------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — companion boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — companion boundary satisfied.');
