#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — memory-governance boundary.
 *
 * Mechanically enforces the contract documented in
 * docs/governance/memory-runtime-boundary.md for src/memory/. Scoped
 * separately from check-runtime-boundary.js because the memory module
 * has a different posture: it MAY INSERT (into two specific tables),
 * SELECT (from a wider allowlist that includes the memory tables),
 * and that's it.
 *
 * Fails the build on:
 *   1. A forbidden SQL keyword in code: UPDATE, DELETE, DROP, ALTER,
 *      TRUNCATE, GRANT, REVOKE, CREATE. (INSERT is allowed but
 *      restricted to two tables — see rule 3.)
 *   2. A FROM/JOIN clause referencing a table outside the memory-
 *      module read allowlist.
 *   3. An INSERT clause referencing a table outside the memory-module
 *      write allowlist.
 *   4. An import of a model SDK (openai, anthropic, @anthropic-ai/sdk,
 *      @openai/*, @anthropic-ai/*).
 *   5. An import of pg from anywhere other than src/memory/client.js.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source is
 * not scanned (it necessarily contains the keywords and table names
 * it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/memory'];

// The single file permitted to import pg inside src/memory/.
const PG_ALLOWED_PATH = 'src/memory/client.js';

// Tables the memory module is permitted to SELECT from (FROM/JOIN).
// Includes the memory tables, the supporting circle/user/pilot tables,
// and the audit log (for any future read paths).
const SELECT_ALLOWED_TABLES = new Set([
  'memory_store',
  'memory_vaults',
  'memory_vault_sessions',
  'governance_audit_log',
  'circle_contacts',
  'users',
  'pilot_instances',
]);

// Tables the memory module is permitted to INSERT into. Tighter than
// the SELECT allowlist — only the two tables the GM-17 surface writes.
const INSERT_ALLOWED_TABLES = new Set([
  'memory_store',
  'governance_audit_log',
]);

// Forbidden write/DDL keywords. UPDATE/DELETE are explicitly banned
// (GM-17 has no UPDATE grants and no DELETE on anything). INSERT is
// allowed but tracked separately (rule 3).
const FORBIDDEN_SQL = /\b(UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/g;

// FROM/JOIN target detection (case-insensitive).
const FROM_JOIN = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

// INSERT INTO target detection (case-insensitive).
const INSERT_INTO = /\bINSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

// CommonJS require() form.
const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const FORBIDDEN_MODULE_EXACT = new Set(['openai', 'anthropic', '@anthropic-ai/sdk']);
const FORBIDDEN_MODULE_PREFIXES = ['@anthropic-ai/', '@openai/'];

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

  // 1. Forbidden SQL keywords (write/DDL).
  const sqlMatches = code.match(FORBIDDEN_SQL);
  if (sqlMatches) {
    const unique = Array.from(new Set(sqlMatches)).sort();
    errors.push(`${rel}: forbidden SQL keyword(s) in code: ${unique.join(', ')}`);
  }

  // 2. FROM/JOIN tables must be in the read allowlist.
  for (const m of code.matchAll(FROM_JOIN)) {
    const table = m[1].toLowerCase();
    if (!SELECT_ALLOWED_TABLES.has(table)) {
      errors.push(`${rel}: FROM/JOIN references non-allowlisted table "${m[1]}"`);
    }
  }

  // 3. INSERT INTO tables must be in the tighter write allowlist.
  for (const m of code.matchAll(INSERT_INTO)) {
    const table = m[1].toLowerCase();
    if (!INSERT_ALLOWED_TABLES.has(table)) {
      errors.push(
        `${rel}: INSERT INTO references non-allowlisted table "${m[1]}" (allowed: memory_store, governance_audit_log)`
      );
    }
  }

  // 4 + 5. Forbidden imports and pg-scoping.
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

console.log('Baseline CI — memory boundary');
console.log('-----------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — memory boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — memory boundary satisfied.');
