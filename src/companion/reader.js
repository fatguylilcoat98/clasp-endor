'use strict';
/*
 * Companion memory reader — the first read-only governed consumer of
 * the GM-17/18 memory-governance library.
 *
 * The reader does ONE thing: package the audit-bundled
 * listVisibleMemories call into an ergonomic, identity-validated
 * function. It owns no pool, no transaction discipline, no RLS
 * binding; all of that lives in src/memory/.
 *
 * Hard rules (also mechanically enforced by
 * scripts/ci/check-companion-boundary.js):
 *   - The companion module never imports pg.
 *   - The companion module never executes raw SQL.
 *   - The companion module imports the memory library only through
 *     its public entry point (require('../memory')) — not through
 *     internal modules like ../memory/repository.
 *   - The companion module never names insertPrivateMemory.
 *   - The companion module never imports http/https/express/fastify.
 *   - The companion module never imports a model SDK.
 *
 * Identity (per OQ-19.6): pilotInstanceId, userId, userRole are
 * supplied by the caller as already-resolved server-side values. The
 * reader validates the shape (UUID + role token) before any DB call;
 * it never authenticates, never resolves usernames, never reads
 * request headers. A future GM that introduces an auth layer will be
 * the caller; the reader is the boundary, not the gate.
 *
 * Logging hygiene (per the GM-18 caller-hygiene rule the boundary doc
 * inherits): the reader logs only counts and identifiers — never
 * memory content. The unit test scans captured log output for a
 * sentinel string planted in fixture content and asserts the
 * sentinel never appears.
 */

const { withMemoryContext } = require('../memory');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(['senior', 'family', 'caregiver', 'admin', 'system']);

function validateInputs(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('readVisibleMemories: input object is required');
  }
  const { pilotInstanceId, userId, userRole, limit } = input;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('readVisibleMemories: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('readVisibleMemories: userId must be a UUID');
  }
  if (typeof userRole !== 'string' || !VALID_ROLES.has(userRole)) {
    throw new Error(
      `readVisibleMemories: userRole must be one of ${Array.from(VALID_ROLES).join(', ')}`
    );
  }
  if (
    limit !== undefined
    && limit !== null
    && !(Number.isInteger(limit) && limit > 0)
  ) {
    throw new Error('readVisibleMemories: limit must be a positive integer when provided');
  }
}

function createCompanionReader(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createCompanionReader: options object is required');
  }
  const { memoryPool, log } = options;
  if (!memoryPool) {
    throw new Error('createCompanionReader: memoryPool is required');
  }
  // log is optional. When absent, the reader emits no log lines. When
  // present, it must duck-type to the src/companion/log.js shape —
  // `info(event, fields)` is the only method the reader calls.
  const logger = log && typeof log.info === 'function' ? log : null;

  async function readVisibleMemories(input) {
    validateInputs(input);
    const { pilotInstanceId, userId, userRole, limit } = input;
    const rows = await withMemoryContext(
      memoryPool,
      { pilotInstanceId, userId, userRole },
      (ctx) => ctx.listVisibleMemories(limit ? { limit } : undefined)
    );
    if (logger) {
      // Log metadata only — never content. The fields below are all
      // safe scalars (ids, counts, role tokens).
      logger.info('companion.memory.read', {
        pilot_instance_id: pilotInstanceId,
        actor_user_id: userId,
        actor_role: userRole,
        count: rows.length,
      });
    }
    return rows;
  }

  // The returned reader exposes ONLY readVisibleMemories. It does
  // not expose `memoryPool`, `pool`, `handle`, `connect`, or `query`
  // — preventing a caller from reaching the pool through the reader
  // even by inspection.
  return Object.freeze({ readVisibleMemories });
}

module.exports = { createCompanionReader };
