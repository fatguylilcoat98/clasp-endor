'use strict';
/*
 * Companion module public API — GM-19.
 *
 * The first read-only governed consumer of the memory-governance
 * library. Library-only (no boot integration, no HTTP, no mount);
 * future GMs that introduce companion behavior will be the first
 * production callers.
 *
 * Surface:
 *   - createCompanionReader({ memoryPool, log? }) → reader with
 *     { readVisibleMemories({pilotInstanceId, userId, userRole, limit?}) }
 *   - MemoryRepositoryError (re-exported from src/memory so callers
 *     can instanceof-check without importing two packages).
 *
 * Operations explicitly NOT in this surface:
 *   - insertPrivateMemory or any other write op (the reader simply
 *     never calls ctx.insertPrivateMemory; the boundary guard
 *     forbids that identifier from appearing in src/companion/).
 *   - visibility promotion / retraction / supersession / vault
 *     opening — all blocked by the same chain of policy + grant +
 *     boundary guard the prior GMs established.
 *   - any raw DB access (pg import banned by the boundary guard).
 *   - any HTTP endpoint or web framework (banned by the boundary
 *     guard).
 *   - any model SDK (banned by the boundary guard).
 */

const { createCompanionReader } = require('./reader');
const { MemoryRepositoryError } = require('../memory');

module.exports = {
  createCompanionReader,
  MemoryRepositoryError,
};
