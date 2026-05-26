'use strict';
/*
 * Memory-governance public API.
 *
 * The only entry points callers should require. The raw pg client,
 * the audit helper, the repository functions, and the underlying
 * pg.Pool are deliberately NOT re-exported — every sensitive op goes
 * through withMemoryContext, which gives the caller a ctx that
 * exposes the audit-bundled operations only.
 *
 * GM-17 first surface (audit-bundled, all read or insert-private-only):
 *   - ctx.listVisibleMemories({ limit? })
 *   - ctx.insertPrivateMemory({ content, provenance })
 *
 * GM-18 hardening (no surface expansion):
 *   - createMemoryPool returns an OPAQUE handle (MemoryPoolHandle).
 *     Callers cannot reach the underlying pg.Pool — only
 *     withMemoryContext can unwrap it.
 *   - Errors thrown from inside fn(ctx) by pg are wrapped into
 *     MemoryRepositoryError so callers never see pg's detail/where/
 *     routine/parameters. Caller-contract validation errors pass
 *     through unchanged.
 *   - Audit event_type is locked to the EVENT_TYPES vocabulary.
 *   - Memory content is capped at MAX_CONTENT_LENGTH bytes (64 KiB).
 *
 * Operations explicitly NOT in this surface (see OQ-17.3, OQ-17.4):
 *   - visibility-level promotion / demotion
 *   - admissibility transitions, retraction, supersession
 *   - vault session opening / failed-attempt accounting / lockout
 * Each of these requires GRANT changes or new RLS policies that
 * GM-17/GM-18 deliberately did not introduce; they are future GMs.
 */

const { createMemoryPool, closeMemoryPool } = require('./client');
const { withMemoryContext } = require('./transaction');
const { MemoryRepositoryError } = require('./errors');
const { createMemoryWriter } = require('./writer');

module.exports = {
  createMemoryPool,
  closeMemoryPool,
  withMemoryContext,
  MemoryRepositoryError,
  createMemoryWriter,
};
