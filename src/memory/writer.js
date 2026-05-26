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
 * - Future layer: Governance review and VERIFIED memories
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

                  // Find and deactivate conflicting memories
                  let searchPattern;
                  if (name) {
                    searchPattern = `User's ${relationship} is named ${name}`;
                  } else {
                    searchPattern = `User's ${relationship}`;
                  }

                  // Deactivate conflicting memories
                  const conflictingMemories = await ctx.findActiveMemoriesContaining(searchPattern);
                  for (const memory of conflictingMemories) {
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
            return await ctx.insertPrivateMemory({
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
      promotedFacts: promotionResult.facts
    };
  }

  return {
    storeWorkingMemories,
  };
}

module.exports = {
  createMemoryWriter,
};