#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — circle-contacts boundary.
 *
 * Mechanically enforces the contract for src/circle/. Scoped
 * separately from check-memory-boundary.js because the circle module
 * touches a different table (circle_contacts) and has its own
 * posture: it MAY INSERT and UPDATE circle_contacts, SELECT from a
 * narrow allowlist (circle_contacts + users for the email lookup
 * and contact display), and that's it.
 *
 * Fails the build on:
 *   1. A forbidden SQL keyword in code: DELETE, DROP, ALTER, TRUNCATE,
 *      GRANT, REVOKE, CREATE. (INSERT and UPDATE are allowed but
 *      restricted — see rules 3 and 4.)
 *   2. A FROM/JOIN clause referencing a table outside the circle-
 *      module read allowlist.
 *   3. An INSERT clause referencing a table outside the circle-module
 *      write allowlist.
 *   4. An UPDATE clause:
 *        - in a file outside UPDATE_ALLOWED_FILES, OR
 *        - targeting a table outside UPDATE_ALLOWED_TABLES, OR
 *        - whose SET clause names a column outside
 *          UPDATE_ALLOWED_COLUMNS.
 *   5. An import of a model SDK (openai, anthropic, @anthropic-ai/sdk,
 *      @openai/*, @anthropic-ai/*).
 *   6. An import of pg from anywhere other than src/circle/client.js.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source is
 * not scanned (it necessarily contains the keywords and table names
 * it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/circle'];

const PG_ALLOWED_PATH = 'src/circle/client.js';

const SELECT_ALLOWED_TABLES = new Set([
  'circle_contacts',
  'users',
  'pilot_instances',
]);

const INSERT_ALLOWED_TABLES = new Set([
  'circle_contacts',
]);

const FORBIDDEN_SQL = /\b(DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/g;

const FROM_JOIN = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
const INSERT_INTO = /\bINSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
const UPDATE_STMT = /\bUPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\s+([^;]*?)(?:\bWHERE\b|\bRETURNING\b|$)/gs;
const SET_COLUMN = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;

const UPDATE_ALLOWED_FILES = new Set(['src/circle/repository.js']);
const UPDATE_ALLOWED_TABLES = new Set(['circle_contacts']);
// Soft-delete is via permission_scope = '[]' rewrite. The schema's
// other columns (id, pilot_instance_id, senior_user_id,
// contact_user_id, created_at) are NOT mutable from this module.
const UPDATE_ALLOWED_COLUMNS = new Set([
  'permission_scope',
]);

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

  // 1. Forbidden SQL keywords.
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

  // 3. INSERT INTO tables must be in the write allowlist.
  for (const m of code.matchAll(INSERT_INTO)) {
    const table = m[1].toLowerCase();
    if (!INSERT_ALLOWED_TABLES.has(table)) {
      errors.push(
        `${rel}: INSERT INTO references non-allowlisted table "${m[1]}" (allowed: ${Array.from(INSERT_ALLOWED_TABLES).join(', ')})`
      );
    }
  }

  // 4. UPDATE statements — narrowly scoped.
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
          `${rel}: UPDATE circle_contacts SET "${cm[1]}" — column outside allowlist (allowed: ${Array.from(UPDATE_ALLOWED_COLUMNS).join(', ')})`
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
    if (specifier === '../gauntlet' || specifier === '../gauntlet/index' || /^\.\.\/gauntlet\//.test(specifier)) {
      errors.push(`${rel}: forbidden import "${specifier}" — src/gauntlet/ is test-only`);
    }
  }
}

console.log('Baseline CI — circle boundary');
console.log('-----------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — circle boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — circle boundary satisfied.');
