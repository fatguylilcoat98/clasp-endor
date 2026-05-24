#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — conversation-runtime boundary (GM-20).
 *
 * Mechanically enforces the contract documented in
 * docs/governance/conversation-runtime-boundary.md for
 * src/conversation/. The conversation module is the only layer
 * permitted to import the model SDK and to make an outbound network
 * call; this guard locks every other capability down.
 *
 * Fails the build on:
 *   1. Any forbidden SQL keyword in code (INSERT, UPDATE, DELETE,
 *      DROP, ALTER, TRUNCATE, GRANT, REVOKE, CREATE, SELECT, FROM,
 *      JOIN, WHERE). The conversation module has zero raw SQL —
 *      every memory access goes through the companion reader.
 *   2. The identifier `insertPrivateMemory` anywhere in code (defense
 *      in depth against a future contributor calling the memory
 *      module's write op through the companion `ctx`).
 *   3. An import of `pg` (no direct DB access).
 *   4. An import of any model SDK other than `@anthropic-ai/sdk`
 *      (single-SDK rule, OQ-20.2).
 *   5. An import of an HTTP/server framework (`http`, `https`,
 *      `express`, `fastify`, `koa`, `@hapi/hapi`). The conversation
 *      module is library code; it does not mount endpoints.
 *   6. An import of `child_process`, `worker_threads`, or `cluster`
 *      (no subprocess, no worker thread, no fork).
 *   7. A memory-module import. The conversation module reads memory
 *      ONLY through the companion module's public entry
 *      (`../companion` or `../companion/index`). Any `../memory*`
 *      path is rejected.
 *   8. A runtime / setup import (`../runtime`, `../db`, `../setup`).
 *   9. Companion-module imports reaching deeper than the public
 *      entry (`../companion/reader`, etc.).
 *  10. Streaming identifiers: `.stream(`, `messages.stream`, the
 *      literal substring `stream: true` (with optional whitespace).
 *  11. Tool / function-calling identifiers: `tools`, `tool_choice`,
 *      `tool_use`, `tool_result` (as object keys or property
 *      accessors).
 *  12. Scheduling identifiers: `setInterval`, `setImmediate`, `cron`,
 *      `schedule`. (`setTimeout` is permitted — the SDK uses it
 *      internally for request timeouts.)
 *  13. Filesystem-write API surface: `fs.writeFile*`, `fs.appendFile*`,
 *      `fs.createWriteStream`, `fs.mkdir*`, `fs.rm*`, `fs.unlink*`.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source is
 * not scanned (it necessarily contains the keywords and identifiers
 * it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/conversation'];

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|SELECT|FROM|JOIN|WHERE)\b/g;

const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Modules whose import is forbidden anywhere in src/conversation/.
const FORBIDDEN_MODULE_EXACT = new Set([
  'pg',
  'http',
  'https',
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
  'child_process',
  'worker_threads',
  'cluster',
  'node:child_process',
  'node:worker_threads',
  'node:cluster',
  'openai',
  'anthropic',
]);
const FORBIDDEN_MODULE_PREFIXES = ['@openai/'];

// The single approved model SDK.
const ALLOWED_MODEL_SDK = '@anthropic-ai/sdk';

// Anthropic publishes some helpers as @anthropic-ai/<thing>. Anything
// under that org other than the SDK itself requires explicit owner
// approval — fail by default.
function isApprovedAnthropicImport(specifier) {
  return specifier === ALLOWED_MODEL_SDK;
}
function isForbiddenAnthropicImport(specifier) {
  return specifier.startsWith('@anthropic-ai/') && !isApprovedAnthropicImport(specifier);
}

// Cross-layer import rules. The conversation module reads memory ONLY
// through the companion module's public entry. Memory-module imports
// of any form are rejected.
const FORBIDDEN_PATH_PREFIXES = ['../memory', '../runtime', '../db', '../setup', '../../scripts/setup'];
const COMPANION_DEEP_RE = /^\.\.\/companion\/.+/;
const COMPANION_ENTRY_PATHS = new Set(['../companion', '../companion/index']);

// Identifier-level scans (post-comment-stripping).
const FORBIDDEN_IDENTIFIERS = [
  { re: /\binsertPrivateMemory\b/, label: 'insertPrivateMemory (memory-write op)' },
  { re: /\bsetInterval\b/, label: 'setInterval (no scheduling)' },
  { re: /\bsetImmediate\b/, label: 'setImmediate (no scheduling)' },
  { re: /\bcron\b/, label: 'cron (no scheduling)' },
  { re: /\bschedule\b/, label: 'schedule (no scheduling)' },
  // Streaming surface — the Anthropic SDK's streaming entry point.
  { re: /\.stream\s*\(/, label: '.stream( (streaming forbidden)' },
  { re: /\bmessages\.stream\b/, label: 'messages.stream (streaming forbidden)' },
  { re: /\bstream\s*:\s*true\b/, label: 'stream: true (streaming forbidden)' },
  // Tool / function calling — the Anthropic SDK enables tools by
  // passing these fields in the request. We reject the field names
  // as identifiers anywhere in source.
  { re: /\btools\b/, label: 'tools (tool-calling forbidden)' },
  { re: /\btool_choice\b/, label: 'tool_choice (tool-calling forbidden)' },
  { re: /\btool_use\b/, label: 'tool_use (tool-calling forbidden)' },
  { re: /\btool_result\b/, label: 'tool_result (tool-calling forbidden)' },
  // fs writes.
  { re: /\bfs\.writeFile/, label: 'fs.writeFile* (no filesystem writes)' },
  { re: /\bfs\.appendFile/, label: 'fs.appendFile* (no filesystem writes)' },
  { re: /\bfs\.createWriteStream\b/, label: 'fs.createWriteStream (no filesystem writes)' },
  { re: /\bfs\.mkdir/, label: 'fs.mkdir* (no filesystem writes)' },
  { re: /\bfs\.rm/, label: 'fs.rm* (no filesystem writes)' },
  { re: /\bfs\.unlink/, label: 'fs.unlink* (no filesystem writes)' },
];

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
  if (isForbiddenAnthropicImport(specifier)) return true;
  return false;
}

function isForbiddenPathSpecifier(specifier) {
  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    if (specifier === prefix || specifier.startsWith(prefix + '/')) return true;
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

  // 2, 10, 11, 12, 13. Identifier scans.
  for (const { re, label } of FORBIDDEN_IDENTIFIERS) {
    if (re.test(code)) {
      errors.push(`${rel}: forbidden identifier — ${label}`);
    }
  }

  // 3-9. Import discipline.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];

    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
      continue;
    }
    if (isForbiddenPathSpecifier(specifier)) {
      errors.push(
        `${rel}: forbidden cross-layer import "${specifier}" — conversation must not reach memory/runtime/db/setup directly`
      );
      continue;
    }
    if (COMPANION_DEEP_RE.test(specifier) && !COMPANION_ENTRY_PATHS.has(specifier)) {
      errors.push(
        `${rel}: companion-module import "${specifier}" reaches past the public entry — allowed: "../companion" or "../companion/index"`
      );
    }
  }
}

console.log('Baseline CI — conversation boundary');
console.log('-----------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — conversation boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — conversation boundary satisfied.');
