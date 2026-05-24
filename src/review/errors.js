'use strict';
/*
 * ReviewRepositoryError — the only error shape the review module
 * propagates when a database operation fails inside a
 * withReviewContext callback.
 *
 * Mirrors src/memory/errors.js MemoryRepositoryError. Distinct
 * class (per OQ-23.3) so future actor modules can `instanceof`-check
 * on the precise origin layer.
 *
 * Carries only `name`, `error_class` (a coarse SQLSTATE or err.name),
 * and a fixed safe message. Crucially does NOT carry pg's `detail`,
 * `where`, `routine`, `parameters`, or raw `message` — any of which
 * can echo payload_summary content (which may contain proposed
 * memory text) into a caller's logs.
 *
 * Caller-contract validation errors (UUID/role/Decision-shape
 * checks done in the actor) are NOT wrapped — they pass through as
 * descriptive plain Errors per the convention established in
 * GM-18 OQ-18.7.
 */

class ReviewRepositoryError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.name = 'ReviewRepositoryError';
    this.error_class = errorClass;
  }
}

function isPgError(err) {
  return (
    err
    && typeof err === 'object'
    && typeof err.code === 'string'
    && err.code.length === 5
  );
}

function describeErrorClass(err) {
  if (!err) return 'unknown';
  if (typeof err.code === 'string' && err.code.length === 5) return err.code;
  return err.name || 'error';
}

module.exports = { ReviewRepositoryError, isPgError, describeErrorClass };
