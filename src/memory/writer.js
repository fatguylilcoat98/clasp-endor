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
    const facts = extractMemoriableFacts(userMessage, { logger });

    // Filter by confidence threshold
    const qualifiedFacts = facts.filter(fact => fact.confidence >= minConfidence);

    if (qualifiedFacts.length === 0) {
      if (logger) {
        logger('debug', 'memory.writer.no_facts', {
          message_length: userMessage.length,
          facts_found: facts.length,
          min_confidence: minConfidence
        });
      }
      return { stored: 0, facts: [] };
    }

    // Store each qualified fact as a working memory
    const storedMemories = [];

    for (const fact of qualifiedFacts) {
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
          logger('warn', 'memory.writer.store_failed', {
            fact_content_length: fact.content.length,
            confidence: fact.confidence,
            error: error.message
          });
        }
        // Continue with other facts even if one fails
      }
    }

    if (logger) {
      logger('info', 'memory.writer.completed', {
        pilot_instance_id: pilotInstanceId,
        user_id: userId,
        facts_extracted: facts.length,
        facts_qualified: qualifiedFacts.length,
        memories_stored: storedMemories.length
      });
    }

    return {
      stored: storedMemories.length,
      facts: storedMemories,
      extracted: facts.length,
      qualified: qualifiedFacts.length
    };
  }

  return {
    storeWorkingMemories,
  };
}

module.exports = {
  createMemoryWriter,
};