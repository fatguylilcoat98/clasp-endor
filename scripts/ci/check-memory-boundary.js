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
 *   1. A forbidden SQL keyword in code: DELETE, DROP, ALTER, TRUNCATE,
 *      GRANT, REVOKE, CREATE. (INSERT and UPDATE are allowed but
 *      restricted — see rules 3 and 4.)
 *   2. A FROM/JOIN clause referencing a table outside the memory-
 *      module read allowlist.
 *   3. An INSERT clause referencing a table outside the memory-module
 *      write allowlist.
 *   4. An UPDATE clause:
 *        - in a file outside UPDATE_ALLOWED_FILES, OR
 *        - targeting a table outside UPDATE_ALLOWED_TABLES, OR
 *        - whose SET clause names a column outside
 *          UPDATE_ALLOWED_COLUMNS.
 *      The DB-level immutability trigger from db/migrations/015 is the
 *      authoritative defense; this guard is a paired static check so a
 *      stray UPDATE in a new memory file fails CI before it reaches
 *      the trigger.
 *   5. An import of a model SDK (openai, anthropic, @anthropic-ai/sdk,
 *      @openai/*, @anthropic-ai/*).
 *   6. An import of pg from anywhere other than src/memory/client.js.
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

// Forbidden write/DDL keywords. DELETE/DROP/etc. are flat banned.
// INSERT is allowed but tracked separately (rule 3). UPDATE is allowed
// only when narrowly scoped (rule 4).
const FORBIDDEN_SQL = /\b(DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/g;

// FROM/JOIN target detection. Case-sensitive uppercase — real SQL in
// this codebase uses uppercase keywords; lowercase "from this …" in
// prompt strings is English text, not a query.
const FROM_JOIN = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;

// INSERT INTO target detection. Same uppercase-only rule.
const INSERT_INTO = /\bINSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;

// UPDATE detection. We capture the table name AND the SET column list
// so we can reject any column outside the allowlist. Same uppercase
// posture as FROM_JOIN.
const UPDATE_STMT = /\bUPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\s+([^;]*?)(?:\bWHERE\b|\bRETURNING\b|$)/gs;
const SET_COLUMN = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;

// Files permitted to issue UPDATE statements at all.
const UPDATE_ALLOWED_FILES = new Set(['src/memory/repository.js']);

// Tables the memory module is permitted to UPDATE.
const UPDATE_ALLOWED_TABLES = new Set(['memory_store']);

// Columns the memory module is permitted to mutate on UPDATE. The
// db/migrations/015 immutability trigger blocks the rest (id,
// pilot_instance_id, owning_user_id, content, provenance, created_at)
// at the DB layer; this list mirrors that contract.
const UPDATE_ALLOWED_COLUMNS = new Set([
  'memory_status',
  'active',
  'updated_at',
]);

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

  // 4. UPDATE statements — narrowly scoped. File + table + columns
  //    must all be allowed. The db trigger from migration 015 is the
  //    authoritative defense; this static check fails CI before a
  //    stray UPDATE in a new file can reach the trigger at runtime.
  for (const m of code.matchAll(UPDATE_STMT)) {
    const table = m[1].toLowerCase();
    const setClause = m[2] || '';
    if (!UPDATE_ALLOWED_FILES.has(rel)) {
      errors.push(
        `${rel}: UPDATE is permitted only in ${Array.from(UPDATE_ALLOWED_FILES).join(', ')}`
      );
      continue;
    }
    if (!UPDATE_ALLOWED_TABLES.has(table)) {
      errors.push(
        `${rel}: UPDATE references non-allowlisted table "${m[1]}" (allowed: ${Array.from(UPDATE_ALLOWED_TABLES).join(', ')})`
      );
      continue;
    }
    for (const cm of setClause.matchAll(SET_COLUMN)) {
      const col = cm[1].toLowerCase();
      if (!UPDATE_ALLOWED_COLUMNS.has(col)) {
        errors.push(
          `${rel}: UPDATE memory_store SET "${cm[1]}" — column outside allowlist (allowed: ${Array.from(UPDATE_ALLOWED_COLUMNS).join(', ')})`
        );
      }
    }
  }

  // 5 + 6. Forbidden imports and pg-scoping.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
    }
    if (specifier === 'pg' && rel !== PG_ALLOWED_PATH) {
      errors.push(`${rel}: pg may only be imported from ${PG_ALLOWED_PATH}`);
    }
    // 6. The gauntlet (GM-30) is test-only; memory must never
    //    import it. Enforces OQ-30.12 reciprocity.
    if (specifier === '../gauntlet' || specifier === '../gauntlet/index' || /^\.\.\/gauntlet\//.test(specifier)) {
      errors.push(`${rel}: forbidden import "${specifier}" — src/gauntlet/ is test-only (GM-30)`);
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
