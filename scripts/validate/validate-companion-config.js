'use strict';
/*
 * Companion configuration validation core.
 *
 * The single interpreter of the configuration contract
 * (config/companion.schema.json). Used by baseline CI now, and by the
 * runtime config loader once that is extracted — both consume this
 * module so the contract has exactly one interpreter.
 *
 * See docs/governance/companion-config-contract.md.
 *
 * Validation is fail-closed: callers treat anything other than
 * { valid: true } as a hard failure.
 */

const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'companion.schema.json');

// Identity fields that template mode allows blank but deployed mode
// requires non-empty. Kept in sync with companion.schema.json $comment
// markers and companion-config-contract.md section 4.
const DEPLOYED_REQUIRED_NON_EMPTY = [
  ['companion', 'name'],
  ['companion', 'persona', 'tone'],
  ['companion', 'persona', 'speaking_style'],
];

const VALID_MODES = ['template', 'deployed'];

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

let cachedValidator = null;

// Compiles the schema once. Throws if the schema itself is malformed —
// callers (CI, runtime) treat that as a hard failure.
function getStructuralValidator() {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  cachedValidator = ajv.compile(loadSchema());
  return cachedValidator;
}

function getAtPath(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/*
 * Validate a companion configuration object.
 *
 *   config - the parsed configuration object
 *   mode   - 'template' (identity fields may be blank) or
 *            'deployed' (identity fields must be non-empty)
 *
 * Returns { valid, mode, errors }. Never throws for invalid config; it
 * throws only for an unknown mode or a malformed schema.
 */
function validateCompanionConfig(config, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`unknown validation mode: ${mode} (expected one of ${VALID_MODES.join(', ')})`);
  }

  const errors = [];

  const structural = getStructuralValidator();
  if (!structural(config)) {
    for (const err of structural.errors) {
      errors.push(`${err.instancePath || '/'} ${err.message}`);
    }
  }

  // Deployed mode adds the non-empty assertion on identity fields. The
  // schema already enforces voice_id non-empty when voice.enabled is
  // true, so that case needs no overlay here.
  if (mode === 'deployed') {
    for (const keys of DEPLOYED_REQUIRED_NON_EMPTY) {
      const value = getAtPath(config, keys);
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`/${keys.join('/')} must be non-empty in deployed mode`);
      }
    }
  }

  return { valid: errors.length === 0, mode, errors };
}

module.exports = {
  validateCompanionConfig,
  loadSchema,
  SCHEMA_PATH,
  DEPLOYED_REQUIRED_NON_EMPTY,
  VALID_MODES,
};
