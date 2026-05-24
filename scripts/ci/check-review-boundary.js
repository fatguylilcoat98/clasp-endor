#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — review boundary (GM-23 + GM-24).
 *
 * Mechanically enforces the contracts documented in
 * docs/governance/review-queue-runtime-boundary.md AND
 * docs/governance/review-decision-runtime-boundary.md for
 * src/review/.
 *
 * Mirrors check-memory-boundary.js in posture but for a tighter
 * surface: in GM-24 the review module touches two tables
 * (governance_review_queue + governance_review_decisions). The
 * GM-23 read API was added in GM-24 (per OQ-24.11) — SELECT on
 * governance_review_queue is now permitted; SELECT on
 * governance_review_decisions is also permitted via the LEFT JOIN
 * in listPendingReviewItems.
 *
 * Fails the build on:
 *   1. A forbidden write/DDL SQL keyword (UPDATE, DELETE, DROP,
 *      ALTER, TRUNCATE, GRANT, REVOKE, CREATE — append-only
 *      semantics; INSERT permitted but tracked separately).
 *   2. A FROM/JOIN clause referencing a table outside the review-
 *      module read allowlist (governance_review_queue,
 *      governance_review_decisions, users, pilot_instances).
 *   3. An INSERT INTO targeting any table other than
 *      governance_review_queue OR governance_review_decisions.
 *   4. An import of pg outside src/review/client.js.
 *   5. An import of a model SDK (any).
 *   6. An import of an HTTP/server framework (http, https, express,
 *      fastify, koa, @hapi/hapi).
 *   7. An import of child_process, worker_threads, or cluster.
 *   8. A scheduling identifier: setInterval, setImmediate, cron,
 *      schedule. (setTimeout is permitted — the pg pool uses it
 *      internally for timeouts; the review module code itself
 *      does not call it.)
 *   9. A filesystem-write API: fs.writeFile*, fs.appendFile*,
 *      fs.createWriteStream, fs.mkdir*, fs.rm*, fs.unlink*.
 *  10. The identifier `insertPrivateMemory` (defense in depth —
 *      the review module does not write memory).
 *  11. A streaming or tool-calling identifier (defense in depth).
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source
 * is not scanned (it necessarily contains the keywords and
 * identifiers it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/review'];

const PG_ALLOWED_PATH = 'src/review/client.js';

const SELECT_ALLOWED_TABLES = new Set([
  'governance_review_queue',
  'governance_review_decisions',
  'users',
  'pilot_instances',
]);

const INSERT_ALLOWED_TABLES = new Set([
  'governance_review_queue',
  'governance_review_decisions',
]);

// All write/DDL keywords except INSERT (which is permitted but
// tracked via INSERT_INTO separately).
const FORBIDDEN_SQL = /\b(UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/g;

const FROM_JOIN = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
const INSERT_INTO = /\bINSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const FORBIDDEN_MODULE_EXACT = new Set([
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

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);

const errors = [];
for (const rel of files) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const code = stripComments(raw);

  // 1. No write/DDL SQL keywords (INSERT tracked separately).
  const sqlMatches = code.match(FORBIDDEN_SQL);
  if (sqlMatches) {
    const unique = Array.from(new Set(sqlMatches)).sort();
    errors.push(`${rel}: forbidden SQL keyword(s) in code: ${unique.join(', ')}`);
  }

  // 8, 9, 10, 11. Identifier scans.
  for (const { re, label } of FORBIDDEN_IDENTIFIERS) {
    if (re.test(code)) {
      errors.push(`${rel}: forbidden identifier — ${label}`);
    }
  }

  // 2. FROM/JOIN allowlist.
  for (const m of code.matchAll(FROM_JOIN)) {
    const table = m[1].toLowerCase();
    if (!SELECT_ALLOWED_TABLES.has(table)) {
      errors.push(`${rel}: FROM/JOIN references non-allowlisted table "${m[1]}"`);
    }
  }

  // 3. INSERT INTO allowlist.
  for (const m of code.matchAll(INSERT_INTO)) {
    const table = m[1].toLowerCase();
    if (!INSERT_ALLOWED_TABLES.has(table)) {
      errors.push(
        `${rel}: INSERT INTO references non-allowlisted table "${m[1]}" `
          + `(allowed: ${Array.from(INSERT_ALLOWED_TABLES).join(', ')})`
      );
    }
  }

  // 4, 5, 6, 7. Import discipline.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
    }
    if (specifier === 'pg' && rel !== PG_ALLOWED_PATH) {
      errors.push(`${rel}: pg may only be imported from ${PG_ALLOWED_PATH}`);
    }
  }
}

console.log('Baseline CI — review-queue boundary');
console.log('-----------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — review-queue boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — review-queue boundary satisfied.');
