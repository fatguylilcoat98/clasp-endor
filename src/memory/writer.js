'use strict';
/*
 * Memory writer for working memory layer.
 *
 * Coordinates memory extraction and storage for WORKING_ACTIVE memories.
 * Integrates with the existing audit-bundled memory infrastructure
 * while adding fact extraction and working memory management.
 *
 * Part of the tiered memory architecture:
 * - This layer: WORKING_ACTIVE memories (immediate, unverified)
 * - Promoted layer: VERIFIED (confidence >= 0.9 after promotion)
 * - Future layer: Governance review of staged candidates
 *
 * Memory-write discipline (hardening pass, Task 5):
 *   - Default confidence threshold is 0.5. Below this, an extracted
 *     "fact" is dropped before it ever reaches the DB. Raise via
 *     options.minConfidence for stricter writes.
 *   - Promotion to VERIFIED requires confidence >= 0.9 OR an explicit
 *     personal-info pattern (name, favorite, lives in, works at).
 *     Inferred relationships and emotional assumptions should never
 *     reach 0.9 from the extractor.
 *   - CORRECTION / RETRACTION facts deactivate conflicting memories
 *     with the USER_CORRECTED / USER_RETRACTED audit reason. The
 *     deactivation requires UPDATE grants (added in
 *     db/migrations/016) and the memory_store_owner_update RLS
 *     policy (same migration); the column allowlist
 *     {active, memory_status, updated_at} is enforced both by the
 *     memory-boundary CI guard and by the immutability trigger from
 *     db/migrations/015.
 *
 * Things this writer must NOT do (per hardening Task 5):
 *   - Store inferred relationships as confirmed facts.
 *   - Persist emotional assumptions ("user seemed sad"). The Layer 2
 *     prompt forbids this; if it slips through, the writer's
 *     minConfidence filter is the next line of defense.
 *   - Fabricate timeline. The extractor has no date-extraction
 *     patterns; the writer does not synthesize dates.
 *   - Overwrite identity. The schema's immutability trigger plus the
 *     audit log mean overwrites must go through deactivateMemory +
 *     re-INSERT, leaving a visible trail.
 */

const { withMemoryContext } = require('./transaction');
const { extractMemoriableFacts } = require('./extractor');

/**
 * Create a working memory writer instance.
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.memoryPool - Memory pool handle for database access
 * @param {Function} options.logger - Logger function (level, event, fields)
 * @returns {Object} Memory writer instance
 */
function createMemoryWriter(options = {}) {
  const { memoryPool, logger } = options;

  if (!memoryPool) {
    throw new Error('createMemoryWriter: memoryPool is required');
  }

  /**
   * Store user-stated facts as working memories.
   *
   * @param {Object} input - Input parameters
   * @param {string} input.userMessage - The user's message to extract facts from
   * @param {string} input.pilotInstanceId - Pilot instance ID
   * @param {string} input.userId - User ID
   * @param {string} input.userRole - User role (for context)
   * @param {Object} input.options - Optional parameters
   * @param {number} input.options.minConfidence - Minimum confidence threshold (default: 0.5)
   * @returns {Promise<Object>} Result with stored memories count and details
   */
  async function storeWorkingMemories(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('storeWorkingMemories: input is required');
    }

    const { userMessage, pilotInstanceId, userId, userRole, options: opts = {} } = input;
    // Phase 2: per-turn visibility hint. 'private' (default) routes
    // through ctx.insertPrivateMemory; 'family_shared' routes through
    // ctx.insertSharedMemory. password_locked is NOT permitted here —
    // it requires the vault unlock flow that this milestone does not
    // implement. The hint applies to every fact extracted from THIS
    // chat turn; corrections (CORRECTION:/RETRACTION:) still go in
    // at the chosen tier.
    const visibilityLevel = opts.visibilityLevel === 'family_shared' ? 'family_shared' : 'private';
    const insertFnName = visibilityLevel === 'family_shared' ? 'insertSharedMemory' : 'insertPrivateMemory';

    // Log memory system status
    if (logger) {
      logger.info('memory.writer.system_status', {
        memory_pool_available: !!memoryPool,
        pilot_instance_id: pilotInstanceId,
        user_id: userId,
        user_role: userRole,
        message_length: userMessage ? userMessage.length : 0
      });
    }

    if (!userMessage || typeof userMessage !== 'string') {
      throw new Error('storeWorkingMemories: userMessage is required');
    }
    if (!pilotInstanceId || typeof pilotInstanceId !== 'string') {
      throw new Error('storeWorkingMemories: pilotInstanceId is required');
    }
    if (!userId || typeof userId !== 'string') {
      throw new Error('storeWorkingMemories: userId is required');
    }

    const minConfidence = opts.minConfidence || 0.5;

    // Extract memorable facts from the user message
    const facts = await extractMemoriableFacts(userMessage, { logger });

    // Ensure facts is always an array (guard against extraction failures)
    const factsArray = Array.isArray(facts) ? facts : [];

    // Filter by confidence threshold
    const qualifiedFacts = factsArray.filter(fact => fact && typeof fact === 'object' && typeof fact.confidence === 'number' && fact.confidence >= minConfidence);

    if (qualifiedFacts.length === 0) {
      if (logger) {
        logger.info('memory.writer.no_facts', {
          message_length: userMessage.length,
          facts_found: facts.length,
          min_confidence: minConfidence
        });
      }
      return { stored: 0, facts: [] };
    }

    // Handle corrections and supersessions first
    const corrections = qualifiedFacts.filter(fact =>
      fact.content.startsWith('CORRECTION:') || fact.content.startsWith('RETRACTION:')
    );

    const regularFacts = qualifiedFacts.filter(fact =>
      !fact.content.startsWith('CORRECTION:') && !fact.content.startsWith('RETRACTION:')
    );

    let correctionResults = { superseded: 0, deactivated: 0 };

    // Process corrections to supersede existing memories
    if (corrections.length > 0) {
      try {
        correctionResults = await withMemoryContext(
          memoryPool,
          { pilotInstanceId, userId, userRole },
          async (ctx) => {
            let superseded = 0;
            let deactivated = 0;

            for (const correction of corrections) {
              // Parse the correction to understand what to supersede
              const content = correction.content;

              if (content.startsWith('CORRECTION: User does not have')) {
                const match = content.match(/CORRECTION: User does not have (.+?)(?:\s+named\s+(.+))?$/i);
                if (match) {
                  const relationship = match[1].trim();
                  const name = match[2]?.trim();

                  // Search multiple stored forms — different extractor
                  // patterns produce the same fact in different
                  // orderings. Live test (Daniel-not-my-brother)
                  // showed the old single-form search missed seeded
                  // facts stored in the alternate form. Deduplicate
                  // by id since name-first and relationship-first
                  // searches overlap when both are seeded.
                  const conflictById = new Map();
                  const collect = (rows) => {
                    for (const r of rows) conflictById.set(r.id, r);
                  };
                  if (name) {
                    // Relationship-first: "User's brother is named Daniel"
                    collect(await ctx.findActiveMemoriesContaining(
                      `User's ${relationship} is named ${name}`
                    ));
                    // Name-first: "Daniel is user's brother"
                    collect(await ctx.findActiveMemoriesContaining(
                      `${name} is user's ${relationship}`
                    ));
                    // Name-only fallback — filter in JS to those that
                    // ALSO contain the relationship word. Catches
                    // free-form seeds like "Daniel is Chris's brother"
                    // or operator-inserted variants we don't know
                    // the exact shape of.
                    const byName = await ctx.findActiveMemoriesContaining(name);
                    for (const r of byName) {
                      const lc = (r.content || '').toLowerCase();
                      if (lc.includes(relationship.toLowerCase())) {
                        conflictById.set(r.id, r);
                      }
                    }
                  } else {
                    collect(await ctx.findActiveMemoriesContaining(
                      `User's ${relationship}`
                    ));
                  }

                  for (const memory of conflictById.values()) {
                    await ctx.deactivateMemory(memory.id, 'USER_CORRECTED');
                    deactivated++;
                  }
                }
              } else if (content.startsWith('CORRECTION: User does not like')) {
                const match = content.match(/CORRECTION: User does not like (.+)$/i);
                if (match) {
                  const item = match[1].trim();
                  const searchPattern = `User likes ${item}`;

                  const conflictingMemories = await ctx.findActiveMemoriesContaining(searchPattern);
                  for (const memory of conflictingMemories) {
                    await ctx.deactivateMemory(memory.id, 'USER_CORRECTED');
                    deactivated++;
                  }
                }
              } else if (content.startsWith('RETRACTION:')) {
                const match = content.match(/RETRACTION: Ignore previous statements about (.+)$/i);
                if (match) {
                  const topic = match[1].trim();

                  const conflictingMemories = await ctx.findActiveMemoriesContaining(topic);
                  for (const memory of conflictingMemories) {
                    await ctx.deactivateMemory(memory.id, 'USER_RETRACTED');
                    deactivated++;
                  }
                }
              }
            }

            return { superseded, deactivated };
          }
        );

        if (logger) {
          logger.info('memory.writer.corrections_processed', {
            corrections_found: corrections.length,
            memories_deactivated: correctionResults.deactivated,
            memories_superseded: correctionResults.superseded
          });
        }

      } catch (error) {
        if (logger) {
          logger.warn('memory.writer.corrections_failed', {
            error: error.message,
            corrections_count: corrections.length
          });
        }
      }
    }

    // Store regular facts (non-corrections) and processed corrections
    const storedMemories = [];
    const factsToStore = [...regularFacts, ...corrections];

    for (const fact of factsToStore) {
      try {
        const result = await withMemoryContext(
          memoryPool,
          { pilotInstanceId, userId, userRole },
          async (ctx) => {
            return await ctx[insertFnName]({
              content: fact.content,
              provenance: 'USER_STATED',
              memoryStatus: 'WORKING_ACTIVE'
            });
          }
        );

        storedMemories.push({
          id: result.id,
          content: fact.content,
          confidence: fact.confidence,
          createdAt: result.created_at
        });

      } catch (error) {
        if (logger) {
          logger.warn('memory.writer.store_failed', {
            fact_content_length: fact.content.length,
            confidence: fact.confidence,
            error: error.message
          });
        }
        // Continue with other facts even if one fails
      }
    }

    // Promote high-confidence facts to VERIFIED status for persistent memory
    let promotionResult = { promoted: 0, facts: [] };
    if (storedMemories.length > 0) {
      try {
        promotionResult = await withMemoryContext(
          memoryPool,
          { pilotInstanceId, userId, userRole },
          async (ctx) => {
            // Filter facts that qualify for promotion to VERIFIED status
            const qualifyingFacts = qualifiedFacts.filter(fact => {
              // Promote high-confidence user-stated facts
              if (fact.confidence >= 0.9) return true;
              // Promote explicit remember commands
              if (fact.confidence >= 0.95) return true;
              // Promote personal information patterns
              const content = fact.content.toLowerCase();
              return content.includes('my name is') ||
                     content.includes('favorite') ||
                     content.includes('i live') ||
                     content.includes('i work at');
            });

            if (qualifyingFacts.length === 0) {
              return { promoted: 0, facts: [] };
            }

            // Find matching WORKING_ACTIVE memories
            const contentArray = qualifyingFacts.map(f => f.content);
            const workingMemories = await ctx.findWorkingMemoriesByContent(contentArray);

            const promotedFacts = [];
            for (const memory of workingMemories) {
              const matchingFact = qualifyingFacts.find(f => f.content === memory.content);
              if (matchingFact) {
                await ctx.promoteMemoryToVerified(
                  memory.id,
                  `promoted to VERIFIED (confidence: ${matchingFact.confidence})`
                );
                promotedFacts.push({
                  id: memory.id,
                  content: memory.content,
                  confidence: matchingFact.confidence,
                  promotedAt: new Date()
                });
              }
            }

            return { promoted: promotedFacts.length, facts: promotedFacts };
          }
        );

        if (logger) {
          logger.info('memory.writer.promotion_completed', {
            facts_promoted: promotionResult.promoted,
            qualified_facts: qualifiedFacts.length
          });
        }

      } catch (error) {
        if (logger) {
          logger.warn('memory.writer.promotion_failed', {
            error: error.message?.substring(0, 100)
          });
        }
        // Continue even if promotion fails
      }
    }

    if (logger) {
      logger.info('memory.writer.completed', {
        pilot_instance_id: pilotInstanceId,
        user_id: userId,
        visibility_level: visibilityLevel,
        facts_extracted: facts.length,
        facts_qualified: qualifiedFacts.length,
        memories_stored: storedMemories.length,
        memories_promoted: promotionResult.promoted
      });
    }

    return {
      stored: storedMemories.length,
      facts: storedMemories,
      extracted: facts.length,
      qualified: qualifiedFacts.length,
      promoted: promotionResult.promoted,
      promotedFacts: promotionResult.facts,
      visibilityLevel,
    };
  }

  return {
    storeWorkingMemories,
  };
}

module.exports = {
  createMemoryWriter,
};
