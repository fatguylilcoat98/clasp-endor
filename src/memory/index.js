'use strict';
/*
 * Memory-governance public API.
 *
 * The only entry points callers should require. The raw pg client,
 * the audit helper, and the repository functions are deliberately
 * NOT re-exported — every sensitive op goes through
 * withMemoryContext, which gives the caller a ctx that exposes the
 * audit-bundled operations only.
 *
 * GM-17 first surface (audit-bundled, all read or insert-private-only):
 *   - ctx.listVisibleMemories({ limit? })
 *   - ctx.insertPrivateMemory({ content, provenance })
 *
 * Operations explicitly NOT in this surface (see OQ-17.3, OQ-17.4):
 *   - visibility-level promotion / demotion
 *   - admissibility transitions, retraction, supersession
 *   - vault session opening / failed-attempt accounting / lockout
 * Each of these requires GRANT changes or new RLS policies that
 * GM-17 deliberately did not introduce; they are future GMs.
 */

const { createMemoryPool, closeMemoryPool } = require('./client');
const { withMemoryContext } = require('./transaction');

module.exports = {
  createMemoryPool,
  closeMemoryPool,
  withMemoryContext,
};
