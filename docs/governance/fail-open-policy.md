# Fail-open / fail-safe policy

This document codifies which layers in the chat path are permitted to
fail open (swallow an error and return a degraded but usable result)
versus which must fail safe (surface the error so the operator sees
it). The rule of thumb: **degrade closest to the user, only when the
data integrity guarantee for the layer permits it.** Layers that own
governance, RLS, or audit invariants must surface errors; layers that
own resilience may absorb them.

## Per-layer policy

| Layer | File | Posture | Rationale |
|---|---|---|---|
| Memory READ | `src/memory/transaction.js`, `src/memory/repository.js` | **Fail safe.** Any error inside `withMemoryContext` rolls back the transaction and rethrows as `MemoryRepositoryError` (pg internals sanitized out). | If the memory read is broken (FK violation, RLS misconfig, schema drift), the operator must see it. Silently returning empty would mean every chat proceeds with zero memory context — invisible failure. |
| Companion reader | `src/companion/reader.js` | **Fail safe.** No try/catch; propagates `MemoryRepositoryError` to the caller. | Same rationale. The pre-`fef1259` swallow was a regression and was removed in the hardening pass. The privacy invariant (no pg.detail / pg.where / pg.routine in caller-visible output) is preserved by the wrapper in `withMemoryContext`. |
| Memory WRITE | `src/memory/writer.js` (`storeWorkingMemories`) | **Fail open** (per-fact). Each fact's INSERT is wrapped in try/catch; one failing fact does not abort the batch. Correction-processing also try/catches. | A write hiccup (transient lock, transient connection) should not prevent the user's *response* this turn. The user can re-state the fact next turn. The audit log preserves whatever write events did complete. |
| Extractor / auditor | `src/memory/extractor.js`, `src/conversation/auditor.js` | **Fail open.** Layer 2 Groq extraction and Groq audit both return safe defaults (`[]` and `{verdict: 'PASS', details: ...}`) when the SDK is unavailable, the API call fails, or the response is unparseable. | These are *advisory*. Layer 1 patterns are the durable extractor. The auditor is a secondary consistency check, not a gate. |
| Brain pipeline | `src/conversation/brain.js`, `src/conversation/brain-runtime.js` | **Fail open + fall back.** Each of the 8 stages reports `degraded: true` on individual failure. If `processWithBrain` throws, `createBrainEnabledRuntime` falls back to the standard `createConversationRuntime`. | The brain is an enhancement layer. A standard-runtime response is always preferable to no response. |
| Conversation runtime | `src/conversation/runtime.js` | **Fail safe.** Propagates errors from the companion reader and the SDK. | If memory or the model itself fails, the caller (web layer) must know. |
| Wiring `handleChat` post-success | `src/web/wiring.js` | **Fail open** on memory WRITE. The `memoryWriter.storeWorkingMemories` call after a successful response is wrapped in try/catch so a write failure does not turn a successful response into a 502. Logged as `wiring.memory_write_failed`. | Write failure after the response is already generated is a non-blocking issue. The chat already responded; we should not retroactively fail it. |
| HTTP server | `src/web/server.js` (`handleChat`, top-level `route`) | **Fail safe HTTP-level.** Errors from `wiring.handleChat` are caught and returned as `502 {error: "model call failed", errorClass: ...}`. The process stays up. | An unhandled error would crash the Node process; that's worse than a clean 502. The client sees the error class without pg internals. |
| Boot / health | `src/runtime/boot.js`, `src/runtime/boot-web.js` | **Fail safe.** Boot refuses to start when env is invalid; process exits non-zero. | Bad env should not be silently absorbed. The operator must see it at deploy time, not when the first request comes in. |

## Privacy invariants (enforced at every layer)

Regardless of fail-open or fail-safe posture, the following invariants
hold across every layer above:

- **No pg internals leak.** `MemoryRepositoryError` strips
  `pg.detail`, `pg.where`, `pg.routine`. The wrapped error message is
  always the literal string `"memory operation failed"`.
- **No user message text in logs.** `web.chat.responded` logs only
  `message_bytes`, never `userMessage`. Same for the brain pipeline.
- **No model response text in logs.** Logs carry `response_chars`,
  never the response.
- **No memory content in admin ring buffer.** The ring stores
  `memoryCount`, `outcome`, `decision`, `auditVerdict`,
  `memoriesStored`, `factsExtracted` — no content.
- **No memory content in audit reasons.** The audit row carries a
  `reason` field but the deactivate path uses literal labels like
  `USER_CORRECTED`, not the content of the corrected memory.

## Where to add new fail-open behavior

Future fail-open additions go on layers that already fail open:
extractor / auditor / brain / memory-write. New fail-open on a layer
currently fail-safe (reader, runtime, boot, RLS) requires a paired
explanation in this document plus an updated test that asserts what
the new degraded state actually returns and what the operator sees in
the log. The reader's pre-`fef1259` swallow is a case study in how
silent fail-open at the wrong layer corrupts governance: configuration
bugs become invisible and the conversation responds with zero context
forever. Don't repeat that.

## Verification

This policy is exercised by:

- `tests/integration/companion-read.test.js` — asserts the reader
  throws `MemoryRepositoryError` for an FK violation, with pg
  internals stripped.
- `tests/integration/conversation-mounted.test.js` — asserts the
  runtime lets that error propagate and does NOT call the model SDK.
- `tests/web/server.test.js` — asserts the HTTP server returns 502
  with the sanitized `errorClass` when wiring throws.
- `tests/memory/writer.test.js` — asserts the writer's per-fact
  try/catch does not abort the batch.
- `tests/integration/memory-supersession.test.js` — asserts the
  correction path completes end-to-end (writer fail-open does not
  hide a real success).
