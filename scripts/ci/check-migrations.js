#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — migration discipline.
 *
 * Hard-fails the build when:
 *   1. a numbered migration in db/migrations/ violates NNN_name.sql
 *   2. two migrations share the same NNN number
 *   3. a .sql file appears outside an approved location
 *
 * Approved .sql locations:
 *   - db/migrations/NNN_*.sql   the numbered chain
 *   - db/schema.sql             canonical schema dump
 *   - tests/**                  synthetic test schema / fixtures
 *   - seed/**                   demo seed data
 *   - OPERATIONAL_SQL_ALLOWLIST exact-named deployment helpers (Supabase)
 *
 * The master template carries no _archive/ — see check-no-archived-sql.js.
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const MIG = 'db/migrations';
const NUMBERED_RE = /^\d{3}_[a-z0-9][a-z0-9_-]*\.sql$/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.relative(REPO, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
}

const all = [];
walk(REPO, all);
const sql = all.filter((f) => f.toLowerCase().endsWith('.sql'));

const errors = [];

const seen = new Map();
for (const f of sql) {
  if (!f.startsWith(MIG + '/')) continue;
  const name = f.slice(MIG.length + 1);
  if (name.includes('/')) continue; // caught by the stray-file check below
  if (!NUMBERED_RE.test(name)) {
    errors.push(`Migration filename violates NNN_name.sql format: ${f}`);
    continue;
  }
  const num = name.slice(0, 3);
  if (seen.has(num)) {
    errors.push(`Duplicate migration number ${num}: ${seen.get(num)} and ${f}`);
  } else {
    seen.set(num, f);
  }
}

// Operational deployment helpers — exact filenames only. These are NOT
// canonical migrations; canonical migrations live in db/migrations/.
//
//   MASTER_MIGRATION.sql      — consolidated, idempotent (IF NOT
//                               EXISTS) script for Supabase SQL editor.
//                               Mirrors db/migrations/001-015 in one
//                               file so the operator can stand up a
//                               fresh Supabase project in one paste.
//   VERIFICATION_QUERY.sql    — read-only sanity SELECTs the operator
//                               runs against the deployed DB.
//
// Adding another helper requires a paired entry here and a comment
// describing it. No glob, no "anything at root" — explicit names only.
const OPERATIONAL_SQL_ALLOWLIST = new Set([
  'MASTER_MIGRATION.sql',
  'VERIFICATION_QUERY.sql',
]);

function approved(f) {
  if (f.startsWith('tests/')) return true;
  if (f.startsWith('seed/')) return true;
  if (f === 'db/schema.sql') return true;
  if (f.startsWith(MIG + '/') && !f.slice(MIG.length + 1).includes('/')) return true;
  if (OPERATIONAL_SQL_ALLOWLIST.has(f)) return true;
  return false;
}
for (const f of sql) {
  if (!approved(f)) errors.push(`Stray .sql outside approved locations: ${f}`);
}

console.log('Baseline CI — migration discipline');
console.log('----------------------------------');
console.log(`.sql files scanned: ${sql.length}`);
console.log(`Numbered migrations: ${seen.size}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — migration discipline violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — migration discipline satisfied.');
