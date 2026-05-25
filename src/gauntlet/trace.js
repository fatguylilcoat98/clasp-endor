'use strict';
/*
 * Per-stage trace capture for the gauntlet runner.
 *
 * Records the stage name, ok/!ok, duration, and (on failure)
 * the typed error class only — never the raw error message,
 * because actor / repository errors may quote DB-side details
 * that are too specific to log structurally.
 */

const LAYER_BY_STAGE = Object.freeze({
  'classifier': 'classifier',
  'actor.verifyDecisionOrThrow': 'actor-layer-1',
  'actor.validateParams': 'actor-layer-7',
  'actor.vocabularyPrecondition': 'actor-layer-8',
  'withReviewContext.begin': 'rls',
  'ctx.invoke': 'db-trigger',
  'withReviewContext.rollback': 'rls',
  'withReviewContext.commit': 'rls',
  'static-scan': 'static-scan',
  'boundary-guard': 'boundary-guard',
  'snapshot-check': 'snapshot',
  'forgery.construct': 'actor-layer-1',
});

function createTrace() {
  const entries = [];

  function record(stage, ok, ms, errorClass) {
    const entry = { stage, ok, ms };
    if (errorClass) entry.errorClass = errorClass;
    entries.push(entry);
  }

  async function timed(stage, fn) {
    const start = Date.now();
    try {
      const out = await fn();
      record(stage, true, Date.now() - start);
      return out;
    } catch (err) {
      const cls = err && (err.code || err.name) || 'Error';
      record(stage, false, Date.now() - start, cls);
      throw err;
    }
  }

  function snapshot() {
    return entries.map((e) => Object.assign({}, e));
  }

  return Object.freeze({ record, timed, snapshot });
}

function inferLayerHit(traceEntries) {
  for (let i = traceEntries.length - 1; i >= 0; i -= 1) {
    const e = traceEntries[i];
    if (!e.ok) {
      // GM-30 harness-corrective patch: the actor's `execute`
      // wraps DB-side rejections into ReviewRepositoryError via
      // src/review/transaction.js sanitizeError. When the stage
      // is the generic actor.invoke entrypoint AND the wrapped
      // error class is ReviewRepositoryError, the rejection
      // landed at the DB layer — UNIQUE, CHECK, trigger, RLS
      // WITH CHECK, or GRANT — but the sanitizer intentionally
      // discards which sub-layer fired. db-rejection is the
      // conservative bucket. Probes needing exact sub-layer
      // discrimination should issue raw SQL via
      // tests/integration/*.test.js where the original error
      // class survives.
      if (e.stage === 'actor.invoke' && e.errorClass === 'ReviewRepositoryError') {
        return 'db-rejection';
      }
      return LAYER_BY_STAGE[e.stage] || null;
    }
  }
  return null;
}

module.exports = { createTrace, inferLayerHit, LAYER_BY_STAGE };
