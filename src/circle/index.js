'use strict';
/*
 * Circle-contacts public API.
 *
 * The only entry points callers should require. The raw pg client,
 * the repository functions, and the underlying pg.Pool are
 * deliberately NOT re-exported — every op goes through
 * withCircleContext, which gives the caller a ctx that exposes the
 * audit-safe operations only.
 *
 * Operations explicitly NOT in this surface:
 *   - vault unlock / PIN management (future GM)
 *   - password_locked visibility grants (requires vault state)
 *   - cross-pilot contact membership (pilot scope is enforced)
 */

const { createCirclePool, closeCirclePool } = require('./client');
const { withCircleContext } = require('./transaction');
const { VALID_VISIBILITY_TIERS } = require('./repository');

module.exports = {
  createCirclePool,
  closeCirclePool,
  withCircleContext,
  VALID_VISIBILITY_TIERS,
};
