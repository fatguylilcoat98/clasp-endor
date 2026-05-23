'use strict';
/*
 * Runtime environment parsing.
 *
 * Pure: reads a raw environment object and returns a typed result. It
 * performs no I/O — no database connection, no network. It only reads
 * strings. DATABASE_URL is read as an opaque string; this module never
 * connects to anything.
 *
 * Fail-closed: a missing or unparseable required variable is reported
 * as an error. The GM-7b boot sequence treats a non-ok result as fatal.
 *
 * Feature flags follow the three-layer model in
 * docs/governance/feature-flag-model.md. Every flag defaults to false —
 * a copied instance never inherits a "live" flag state.
 */

// Environment variable -> result key. Layer 1 is the master switch;
// Layer 2 (RLS enforcement) is independent of Layer 1; Layer 3 are
// capability sub-flags.
const BOOLEAN_FLAGS = Object.freeze({
  LYLO_SHELL_MODE: 'masterSwitch',
  RLS_ENFORCED: 'rlsEnforced',
  SETUP_MODE_ENABLED: 'setupModeEnabled',
  VOICE_ENABLED: 'voiceEnabled',
  LEGACY_PROJECT_MODE_ENABLED: 'legacyProjectModeEnabled',
});

const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0', '']);

// Health/readiness server port. Defaults to 3000 when PORT is unset.
const DEFAULT_PORT = 3000;

function parseBoolean(raw) {
  if (raw === undefined || raw === null) return { value: false, error: null };
  const norm = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(norm)) return { value: true, error: null };
  if (FALSE_VALUES.has(norm)) return { value: false, error: null };
  return { value: false, error: `expected a boolean (true/false), got "${raw}"` };
}

function parsePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: DEFAULT_PORT, error: null };
  }
  const norm = String(raw).trim();
  if (!/^[0-9]+$/.test(norm)) {
    return { value: DEFAULT_PORT, error: `expected an integer, got "${raw}"` };
  }
  const n = Number(norm);
  if (n < 1 || n > 65535) {
    return { value: DEFAULT_PORT, error: `expected a port in 1-65535, got "${raw}"` };
  }
  return { value: n, error: null };
}

/*
 * Parse a raw environment object.
 *
 *   rawEnv - an object of environment variables (the caller passes
 *            process.env; tests pass a literal)
 *
 * Returns { ok, errors, flags, databaseUrl, pilotInstanceId }.
 */
function parseEnv(rawEnv) {
  const env = rawEnv || {};
  const errors = [];
  const flags = {};

  for (const [name, key] of Object.entries(BOOLEAN_FLAGS)) {
    const { value, error } = parseBoolean(env[name]);
    if (error) errors.push(`${name}: ${error}`);
    flags[key] = value;
  }

  // Database connection string. Required for the runtime to load
  // configuration. Read as an opaque string only.
  const databaseUrl = env.DATABASE_URL ? String(env.DATABASE_URL).trim() : '';
  if (!databaseUrl) {
    errors.push('DATABASE_URL: required, but missing or empty');
  }

  // Optional pilot pin. When present it must later match the single
  // pilot_instances row; that cross-check is the loader's job.
  const pilotInstanceId = env.PILOT_INSTANCE_ID
    ? String(env.PILOT_INSTANCE_ID).trim()
    : null;

  // Optional build version override. When absent, boot falls back to
  // package.json#version.
  const version = env.LYLO_VERSION ? String(env.LYLO_VERSION).trim() : null;

  // Health/readiness server port. An unparseable PORT is an error,
  // which the boot sequence treats as configuration-invalid.
  const { value: port, error: portError } = parsePort(env.PORT);
  if (portError) errors.push(`PORT: ${portError}`);

  return {
    ok: errors.length === 0,
    errors,
    flags,
    databaseUrl,
    pilotInstanceId,
    port,
    version,
  };
}

module.exports = { parseEnv, parsePort, BOOLEAN_FLAGS, DEFAULT_PORT };
