'use strict';
/*
 * Test-door wiring.
 *
 * The single place in the test-door web layer that imports the
 * Anthropic SDK and constructs the conversation chain. Kept outside
 * src/runtime/ so the runtime-boundary CI guard (which bans model-SDK
 * imports) remains satisfied — the runtime never depends on this file.
 *
 * Composition order (no governance bypass):
 *   modelClient        — @anthropic-ai/sdk, maxRetries: 0
 *   memoryPool         — opaque handle from src/memory (lylo_app role)
 *   companionReader    — src/companion (governed read surface)
 *   conversationRuntime— src/conversation (single-shot, no tools)
 *   responseActor      — src/actors/response-delivery-actor
 *
 * Every chat request must:
 *   1. classifyExecutionIntent({type: RESPONSE_DELIVER}) → Decision
 *   2. responseActor.execute(decision, params) → outcome bundle
 *
 * The web layer NEVER constructs a Decision directly, NEVER calls the
 * conversation runtime directly, NEVER mocks the model client. Tests
 * inject a fake modelClient via the createTestDoorWiring options.
 */

const Anthropic = require('@anthropic-ai/sdk');

const { createMemoryPool, closeMemoryPool, createMemoryWriter, withMemoryContext } = require('../memory');
const { createCirclePool, closeCirclePool, withCircleContext } = require('../circle');
const { createCompanionReader } = require('../companion');
const { createBrainEnabledRuntime } = require('../conversation/brain-runtime');
const { createResponseDeliveryActor } = require('../actors');
const {
  classifyExecutionIntent,
  INTENT_TYPES,
  DECISION_OUTCOMES,
} = require('../governance');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeErrClass(err) {
  if (!err) return 'unknown';
  if (err && typeof err === 'object') {
    if (err.status) return `http_${err.status}`;
    if (err.code) return String(err.code);
    if (err.name) return String(err.name);
  }
  return 'error';
}

function buildModelClient(env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('test-door wiring: ANTHROPIC_API_KEY is required');
  }
  return new Anthropic({ apiKey, maxRetries: 0 });
}

function buildLogAdapter(emit) {
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

/*
 * createTestDoorWiring
 *   options:
 *     env             — typically process.env; reads ANTHROPIC_API_KEY,
 *                       LYLO_APP_DATABASE_URL.
 *     log             — (level, event, fields) callback. Required.
 *     modelClient     — optional; when present, overrides Anthropic
 *                       construction. Tests inject a fake here.
 *     memoryPool      — optional; when present, skips createMemoryPool.
 *                       Tests inject a fake here.
 *     runtimeConfig   — optional override forwarded to
 *                       createConversationRuntime (model, maxTokens,
 *                       temperature, ...). The locked defaults from
 *                       src/conversation/runtime.js apply otherwise.
 */
function createTestDoorWiring(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createTestDoorWiring: options object is required');
  }
  const { env, log, runtimeConfig } = options;
  if (!env || typeof env !== 'object') {
    throw new Error('createTestDoorWiring: env object is required');
  }
  if (typeof log !== 'function') {
    throw new Error('createTestDoorWiring: log(level, event, fields) callback is required');
  }

  const modelClient = options.modelClient || buildModelClient(env);

  let ownsPool = false;
  let memoryPool = options.memoryPool;
  let circlePool = options.circlePool;
  if (!memoryPool) {
    const dbUrl = env.LYLO_APP_DATABASE_URL;
    if (typeof dbUrl !== 'string' || dbUrl.trim() === '') {
      throw new Error('test-door wiring: LYLO_APP_DATABASE_URL is required');
    }
    memoryPool = createMemoryPool(dbUrl, { log });
    ownsPool = true;
  }
  // Circle pool reuses the same lylo_app credentials; if a test
  // injects memoryPool but not circlePool, we keep circle CRUD
  // disabled to avoid touching a real DB unintentionally.
  let ownsCirclePool = false;
  if (!circlePool && ownsPool) {
    circlePool = createCirclePool(env.LYLO_APP_DATABASE_URL, { log });
    ownsCirclePool = true;
  }

  const logAdapter = buildLogAdapter(log);
  const companionReader = createCompanionReader({ memoryPool, log: logAdapter });
  const memoryWriter = createMemoryWriter({ memoryPool, logger: logAdapter });
  const conversationRuntime = createBrainEnabledRuntime({
    companionReader,
    modelClient,
    log: logAdapter,
    config: runtimeConfig,
  });
  const responseActor = createResponseDeliveryActor({
    conversationRuntime,
    log: logAdapter,
  });

  async function handleChat(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('handleChat: params object is required');
    }
    const { pilotInstanceId, userId, userRole, userMessage, companionConfig, visibilityHint, traceId } = params;
    if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
      const err = new Error('handleChat: pilotInstanceId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      const err = new Error('handleChat: userId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userRole !== 'string' || userRole.length === 0) {
      const err = new Error('handleChat: userRole is required');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userMessage !== 'string' || userMessage.trim() === '') {
      const err = new Error('handleChat: userMessage is required');
      err.userClass = 'bad_request';
      throw err;
    }
    // Phase 2: per-turn visibility hint. Only 'private' (default) and
    // 'family_shared' are accepted. password_locked is rejected here —
    // it requires a vault unlock flow that is out of scope.
    const effectiveVisibility = visibilityHint === 'family_shared' ? 'family_shared' : 'private';
    if (visibilityHint !== undefined && visibilityHint !== null
        && visibilityHint !== 'private' && visibilityHint !== 'family_shared') {
      const err = new Error('handleChat: visibilityHint must be "private" or "family_shared"');
      err.userClass = 'bad_request';
      throw err;
    }

    const decision = classifyExecutionIntent({ type: INTENT_TYPES.RESPONSE_DELIVER });
    const result = await responseActor.execute(decision, {
      pilotInstanceId,
      userId,
      userRole,
      userMessage,
      companionConfig,
      traceId,
    });

    // Store working memories from user message after successful response
    let memoryWriteResult = null;
    if (result.outcome === 'executed') {
      try {
        memoryWriteResult = await memoryWriter.storeWorkingMemories({
          userMessage,
          pilotInstanceId,
          userId,
          userRole,
          options: { minConfidence: 0.5, visibilityLevel: effectiveVisibility }
        });
      } catch (error) {
        // Fail-open: memory write errors should not fail the chat response
        if (log) {
          log('warn', 'wiring.memory_write_failed', {
            pilot_instance_id: pilotInstanceId,
            user_id: userId,
            error_class: describeErrClass(error),
            message: error.message?.substring(0, 100)
          });
        }
        // Set safe defaults so response can continue
        memoryWriteResult = { stored: 0, extracted: 0 };
      }
    }

    const bundle = {
      outcome: result.outcome,
      decision: result.decision.decision,
      intentType: result.decision.intentType,
      reason: result.decision.reason,
      policyRef: result.decision.policyRef,
      response: typeof result.response === 'string' ? result.response : '',
      memoryCount: typeof result.memoryCount === 'number' ? result.memoryCount : 0,
      auditVerdict: result.auditVerdict || 'N/A',
      auditDetails: result.auditDetails || 'no-audit',
      auditReason: result.auditReason,
      memoriesStored: memoryWriteResult?.stored || 0,
      factsExtracted: memoryWriteResult?.extracted || 0,
      visibilityLevel: effectiveVisibility,
    };
    bundle.executed = bundle.outcome === 'executed';

    // Diagnostic — gated by LYLO_DEBUG_RETRIEVAL=true. Surfaces
    // brain pipeline metadata at the top wiring layer so the
    // operator can see whether the brain ran, whether it fell back,
    // and which regions degraded. Per-memory ranking is logged
    // inside brain.js Stage 2 under the same env flag.
    if (String(env.LYLO_DEBUG_RETRIEVAL || '').toLowerCase() === 'true') {
      log('info', 'wiring.debug_chat_summary', {
        pilot_instance_id: pilotInstanceId,
        actor_role: userRole,
        memory_count: bundle.memoryCount,
        memories_stored_this_turn: bundle.memoriesStored,
        facts_extracted_this_turn: bundle.factsExtracted,
        audit_verdict: bundle.auditVerdict,
        brain_meta: result.brainMeta || null,
      });
    }
    return bundle;
  }

  /*
   * listMemoriesForInspector — read-only inspector surface.
   *
   * Opens withMemoryContext with the CALLER's session vars, then
   * calls ctx.listMemoriesForInspector (the inspector-scoped
   * repository read, which INCLUDES superseded + inactive rows so
   * the admin can see the full audit trail). RLS narrows the result
   * to rows the caller is permitted to see — owner via pilot+user,
   * family-shared via circle_contacts, password_locked via open
   * vault session. The inspector does NOT escalate. An admin who
   * has not unlocked a vault sees no password_locked content; an
   * admin who is not in another senior's circle sees no family_
   * shared rows. The admin-role gate is enforced at the HTTP layer
   * (server.js) to hide the inspector UI from non-admin users; it
   * does not widen DB access.
   *
   * Each returned row carries derived metadata so the UI can render
   * badges and tooltips without re-implementing the rules:
   *   - whyVisible: short string explaining the access path
   *   - flags: array of indicator strings (SUPERSEDED, INADMISSIBLE,
   *            CORRECTION, RETRACTION, INFERRED, INACTIVE,
   *            GOVERNANCE_PENDING)
   *   - redacted: boolean — true when the row is password_locked and
   *            the caller is NOT the owner; defense in depth in case
   *            RLS were ever to leak such a row, the inspector still
   *            does not render content
   */
  function computeInspectorMetadata(row, sessionCtx) {
    const owning = row.owning_user_id;
    const isOwner = owning === sessionCtx.userId;
    const flags = [];
    if (row.active === false || row.memory_status === 'SUPERSEDED') flags.push('SUPERSEDED');
    if (row.memory_status === 'GOVERNANCE_PENDING') flags.push('GOVERNANCE_PENDING');
    if (row.admissibility_state === 'inadmissible') flags.push('INADMISSIBLE');
    if (row.provenance === 'AI_INFERRED') flags.push('INFERRED');
    const content = typeof row.content === 'string' ? row.content : '';
    if (content.startsWith('CORRECTION:')) flags.push('CORRECTION');
    if (content.startsWith('RETRACTION:')) flags.push('RETRACTION');
    if (row.authority_level === 'LOW_CONFIDENCE') flags.push('LOW_AUTHORITY');

    let whyVisible;
    if (isOwner) {
      // memory_store_owner matches by pilot+owning_user_id without
      // checking visibility tier — the owner sees their own rows
      // unconditionally, including password_locked. The vault
      // session gate in memory_store_password_locked is for
      // non-owners only.
      whyVisible = row.visibility_level === 'password_locked'
        ? 'owner — RLS matched on pilot + user_id (owner policy is tier-blind; vault session is not required for the owner)'
        : 'owner — RLS matched on pilot + user_id';
    } else if (row.visibility_level === 'password_locked') {
      // A non-owner reaching a password_locked row would require a
      // matching memory_vault_sessions row with their own user_id.
      // memory_vault_sessions has no FOR INSERT policy, so lylo_app
      // cannot fabricate such a session. This row should not be
      // here — defense-in-depth redaction will strip its content.
      whyVisible = 'leaked — non-owner should not see password_locked; content is redacted as defense-in-depth';
    } else if (row.visibility_level === 'family_shared') {
      whyVisible = 'family_shared — caller is in owner\'s circle with the family_shared grant';
    } else if (sessionCtx.userRole === 'admin') {
      // There is intentionally no memory_store_admin policy
      // (OQ-14.2). Admins do NOT see other users' private memories.
      // This branch should not fire — if it does, RLS has surfaced
      // a row the admin policy chain does not cover.
      whyVisible = 'admin — unexpected; no admin SELECT policy on memory_store; investigate as a possible leak';
    } else {
      whyVisible = 'unexpected — RLS surfaced a row that does not match any visibility tier the caller has';
    }

    const redacted = row.visibility_level === 'password_locked' && !isOwner;

    return { whyVisible, flags, redacted };
  }

  async function listMemoriesForInspector(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('listMemoriesForInspector: params object is required');
    }
    const { pilotInstanceId, userId, userRole, limit } = params;
    if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
      const err = new Error('listMemoriesForInspector: pilotInstanceId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      const err = new Error('listMemoriesForInspector: userId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userRole !== 'string' || userRole.length === 0) {
      const err = new Error('listMemoriesForInspector: userRole is required');
      err.userClass = 'bad_request';
      throw err;
    }
    const cap = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100;
    return await withMemoryContext(
      memoryPool,
      { pilotInstanceId, userId, userRole },
      async (ctx) => {
        const rows = await ctx.listMemoriesForInspector({ limit: cap });
        return rows.map((r) => {
          const meta = computeInspectorMetadata(r, { userId, userRole });
          return {
            id: r.id,
            // Redact content if the row is password_locked AND the
            // caller is not the owner. RLS should already filter
            // such rows out, but this is the second line of defense.
            content: meta.redacted ? null : r.content,
            visibility_level: r.visibility_level,
            memory_status: r.memory_status,
            authority_level: r.authority_level,
            provenance: r.provenance,
            admissibility_state: r.admissibility_state,
            owning_user_id: r.owning_user_id,
            active: r.active,
            created_at: r.created_at,
            updated_at: r.updated_at,
            whyVisible: meta.whyVisible,
            flags: meta.flags,
            redacted: meta.redacted,
          };
        });
      }
    );
  }

  /*
   * listGovernanceEvents — read-only audit-log surface for the
   * admin debug panel. Goes through withMemoryContext so RLS narrows
   * by the existing governance_audit_log policies. memory.list
   * events are filtered out by default (each chat turn emits at
   * least one) so the panel surfaces governance-relevant events.
   */
  async function listGovernanceEvents(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('listGovernanceEvents: params object is required');
    }
    const { pilotInstanceId, userId, userRole, limit, includeListEvents } = params;
    if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
      const err = new Error('listGovernanceEvents: pilotInstanceId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      const err = new Error('listGovernanceEvents: userId must be a UUID');
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userRole !== 'string' || userRole.length === 0) {
      const err = new Error('listGovernanceEvents: userRole is required');
      err.userClass = 'bad_request';
      throw err;
    }
    const cap = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
    return await withMemoryContext(
      memoryPool,
      { pilotInstanceId, userId, userRole },
      async (ctx) => {
        const rows = await ctx.listRecentAuditEvents({
          limit: cap,
          includeListEvents: !!includeListEvents,
        });
        return rows.map((r) => ({
          id: r.id,
          memoryId: r.memory_id,
          targetUserId: r.target_user_id,
          eventType: r.event_type,
          actorUserId: r.actor_user_id,
          actorRole: r.actor_role,
          oldVisibility: r.old_visibility,
          newVisibility: r.new_visibility,
          reason: r.reason,
          outcome: r.outcome,
          createdAt: r.created_at,
        }));
      }
    );
  }

  /*
   * Phase 3 — circle-contacts surface.
   *
   * Every op opens withCircleContext bound to the caller's session
   * vars, so RLS narrows reads/writes to the caller's pilot and the
   * caller's own circle. password_locked is rejected by the
   * repository validator — only 'family_shared' is accepted as a
   * visibility tier in this milestone.
   */
  function requireCirclePool() {
    if (!circlePool) {
      const err = new Error('circle CRUD is unavailable: no circle pool wired');
      err.userClass = 'unavailable';
      throw err;
    }
  }

  function validateSession(params, opName) {
    if (!params || typeof params !== 'object') {
      throw new Error(`${opName}: params object is required`);
    }
    const { pilotInstanceId, userId, userRole } = params;
    if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
      const err = new Error(`${opName}: pilotInstanceId must be a UUID`);
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      const err = new Error(`${opName}: userId must be a UUID`);
      err.userClass = 'bad_request';
      throw err;
    }
    if (typeof userRole !== 'string' || userRole.length === 0) {
      const err = new Error(`${opName}: userRole is required`);
      err.userClass = 'bad_request';
      throw err;
    }
    return { pilotInstanceId, userId, userRole };
  }

  async function listCircleContacts(params) {
    const sess = validateSession(params, 'listCircleContacts');
    requireCirclePool();
    return await withCircleContext(circlePool, sess, async (ctx) => {
      return await ctx.listCircleContactsForSenior();
    });
  }

  async function addCircleContact(params) {
    const sess = validateSession(params, 'addCircleContact');
    const { email, visibilityLevels } = params || {};
    if (typeof email !== 'string' || email.trim() === '') {
      const err = new Error('addCircleContact: email is required');
      err.userClass = 'bad_request';
      throw err;
    }
    requireCirclePool();
    return await withCircleContext(circlePool, sess, async (ctx) => {
      const contact = await ctx.lookupUserByEmail(email);
      if (!contact) {
        const err = new Error('no user with that email in your pilot');
        err.userClass = 'not_found';
        throw err;
      }
      return await ctx.insertCircleContact({
        contactUserId: contact.id,
        visibilityLevels: Array.isArray(visibilityLevels) ? visibilityLevels : [],
      });
    });
  }

  async function setCircleContactPermissions(params) {
    const sess = validateSession(params, 'setCircleContactPermissions');
    const { id, visibilityLevels } = params || {};
    if (typeof id !== 'string' || id.length === 0) {
      const err = new Error('setCircleContactPermissions: id is required');
      err.userClass = 'bad_request';
      throw err;
    }
    requireCirclePool();
    return await withCircleContext(circlePool, sess, async (ctx) => {
      return await ctx.setCircleContactScope(
        id,
        Array.isArray(visibilityLevels) ? visibilityLevels : []
      );
    });
  }

  async function close() {
    if (ownsPool && memoryPool) await closeMemoryPool(memoryPool);
    if (ownsCirclePool && circlePool) await closeCirclePool(circlePool);
  }

  return Object.freeze({
    handleChat,
    listMemoriesForInspector,
    listGovernanceEvents,
    listCircleContacts,
    addCircleContact,
    setCircleContactPermissions,
    close,
    classifierOutcomes: DECISION_OUTCOMES,
  });
}

module.exports = {
  createTestDoorWiring,
  describeErrClass,
};
