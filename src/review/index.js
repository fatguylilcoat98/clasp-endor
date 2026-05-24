'use strict';
/*
 * Review-queue module public API — GM-23.
 *
 * The durable governance-staging substrate for requires_review
 * Decisions. Library-only: no boot integration, no HTTP, no
 * process surface. The review-queue actor
 * (src/actors/review-queue-actor.js) is the only intended caller
 * in GM-23; future actors / human-review surfaces (separate
 * decision gates) may use this module too.
 *
 * Surface:
 *   - createReviewQueuePool(databaseUrl, options?)
 *       → opaque ReviewPoolHandle (mirrors GM-18 MemoryPoolHandle)
 *   - closeReviewQueuePool(handle)
 *   - withReviewContext(handle, {pilotInstanceId, userId, userRole}, fn)
 *       → fn(ctx) where ctx exposes stageReviewItem only
 *   - ReviewRepositoryError (sanitized pg-error wrapper)
 *
 * Operations explicitly NOT in this surface:
 *   - listReviewQueue / getReviewItem (no read API in GM-23 per
 *     OQ-23.11; future GM)
 *   - any UPDATE / DELETE op (append-only; no DB grants exist)
 *   - status transitions (locked CHECK on status column)
 *   - dequeue / approval / auto-action paths
 *   - notifications, scheduling, polling — none exist
 */

const { createReviewQueuePool, closeReviewQueuePool } = require('./client');
const { withReviewContext } = require('./transaction');
const { ReviewRepositoryError } = require('./errors');

module.exports = {
  createReviewQueuePool,
  closeReviewQueuePool,
  withReviewContext,
  ReviewRepositoryError,
};
