#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — actor-runtime boundary (GM-22).
 *
 * Mechanically enforces the contract documented in
 * docs/governance/actor-runtime-boundary.md for src/actors/.
 *
 * The actor layer is the first place that imports both
 * src/governance/ (to require Decisions) and src/conversation/ (or,
 * in future GMs, src/companion/ or src/memory/) to perform the
 * downstream action. It must not import internal paths of any
 * other layer, must not import a DB driver, must not introduce
 * scheduling / subprocesses / HTTP / model SDKs of its own.
 *
 * Fails the build on:
 *   1. Any forbidden SQL keyword (INSERT, UPDATE, DELETE, DROP,
 *      ALTER, TRUNCATE, GRANT, REVOKE, CREATE, SELECT, FROM, JOIN,
 *      WHERE). Actors are dispatchers, not data-access code.
 *   2. The identifier `insertPrivateMemory` (defense in depth —
 *      GM-22's actor does not write memory).
 *   3. Imports of `pg`, every model SDK (including
 *      @anthropic-ai/sdk — the conversation runtime owns that
 *      boundary), HTTP/server frameworks, `child_process`,
 *      `worker_threads`, `cluster`.
 *   4. Cross-layer imports that reach `../runtime`, `../db`, or
 *      `../setup` (or any deeper path).
 *   5. Imports from `src/companion/` / `src/memory/` (or any
 *      deeper paths). The GM-22 actor does not touch memory
 *      directly; future actor GMs that need those modules will
 *      get their own boundary guard or relax this rule deliberately.
 *   6. Imports from `../governance/<deeper>` or
 *      `../conversation/<deeper>` — only the public entries
 *      (`../governance` / `../conversation` or their `/index`
 *      forms) are permitted.
 *   7. Scheduling identifiers (`setInterval`, `setImmediate`,
 *      `cron`, `schedule`). `setTimeout` is permitted because it
 *      may appear transitively via the conversation runtime,
 *      though GM-22's actor code does not call it directly.
 *   8. Filesystem-write API surface (`fs.writeFile*`,
 *      `fs.appendFile*`, `fs.createWriteStream`, `fs.mkdir*`,
 *      `fs.rm*`, `fs.unlink*`).
 *   9. Streaming and tool-calling identifiers (`.stream(`,
 *      `messages.stream`, `stream: true`, `tools`, `tool_choice`,
 *      `tool_use`, `tool_result`) — defense in depth; the
 *      conversation runtime already bans these in its own scope.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source
 * is not scanned (it necessarily contains the keywords and
 * identifiers it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/actors'];

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|SELECT|FROM|JOIN|WHERE)\b/g;

const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Modules whose import is forbidden anywhere in src/actors/.
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
  '@anthropic-ai/sdk',
  'openai',
  'anthropic',
]);
const FORBIDDEN_MODULE_PREFIXES = ['@anthropic-ai/', '@openai/'];

// Cross-layer paths the actor module must not reach. Note that
// `../review` is permitted (entry-only, see PUBLIC_ENTRY_LAYERS
// below) — the GM-23 review-queue actor depends on it.
const FORBIDDEN_PATH_PREFIXES = [
  '../runtime',
  '../db',
  '../setup',
  '../../scripts/setup',
  '../memory',
  '../companion',
];

// Public-entry-only rule for the layers actors ARE allowed to
// import. Actors talk to governance for Decisions, to the
// conversation runtime for the response-delivery action (GM-22),
// and to the review-queue substrate for requires_review staging
// (GM-23). Anything deeper (e.g. `../governance/classifier`,
// `../review/repository`) is rejected.
const PUBLIC_ENTRY_LAYERS = ['../governance', '../conversation', '../review'];
const DEEPER_RE = (layer) => new RegExp(`^${layer.replace(/\//g, '\\/')}\\/.+`);
const ENTRY_PATHS = new Set([
  '../governance',
  '../governance/index',
  '../conversation',
  '../conversation/index',
  '../review',
  '../review/index',
]);

// Identifier-level scans (post-comment-stripping).
const FORBIDDEN_IDENTIFIERS = [
  { re: /\binsertPrivateMemory\b/, label: 'insertPrivateMemory (no memory-write op)' },
  { re: /\bsetInterval\b/, label: 'setInterval (no scheduling)' },
  { re: /\bsetImmediate\b/, label: 'setImmediate (no scheduling)' },
  { re: /\bcron\b/, label: 'cron (no scheduling)' },
  { re: /\bschedule\b/, label: 'schedule (no scheduling)' },
  { re: /\.stream\s*\(/, label: '.stream( (no streaming surface)' },
  { re: /\bmessages\.stream\b/, label: 'messages.stream (no streaming surface)' },
  { re: /\bstream\s*:\s*true\b/, label: 'stream: true (no streaming surface)' },
  { re: /\btools\b/, label: 'tools (no tool-calling surface)' },
  { re: /\btool_choice\b/, label: 'tool_choice (no tool-calling surface)' },
  { re: /\btool_use\b/, label: 'tool_use (no tool-calling surface)' },
  { re: /\btool_result\b/, label: 'tool_result (no tool-calling surface)' },
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
  return false;
}

function isForbiddenPath(specifier) {
  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    if (specifier === prefix || specifier.startsWith(prefix + '/')) return true;
  }
  return false;
}

function reachesDeeperThanEntry(specifier) {
  for (const layer of PUBLIC_ENTRY_LAYERS) {
    if (DEEPER_RE(layer).test(specifier) && !ENTRY_PATHS.has(specifier)) {
      return true;
    }
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

  // 2, 7, 8, 9. Identifier scans.
  for (const { re, label } of FORBIDDEN_IDENTIFIERS) {
    if (re.test(code)) {
      errors.push(`${rel}: forbidden identifier — ${label}`);
    }
  }

  // 3, 4, 5, 6. Import discipline.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
      continue;
    }
    if (isForbiddenPath(specifier)) {
      errors.push(
        `${rel}: forbidden cross-layer import "${specifier}" — actors must not reach memory/companion/runtime/db/setup in GM-22`
      );
      continue;
    }
    if (reachesDeeperThanEntry(specifier)) {
      errors.push(
        `${rel}: import "${specifier}" reaches past the public entry of ../governance or ../conversation`
      );
    }
  }
}

console.log('Baseline CI — actors boundary');
console.log('-----------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — actors boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — actors boundary satisfied.');
