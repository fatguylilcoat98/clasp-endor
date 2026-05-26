'use strict';
/*
 * Memory extraction for working memory layer.
 *
 * Identifies user-stated facts from conversations that should be stored
 * as WORKING_ACTIVE memories. Focuses on persistent, factual information
 * about the user, their relationships, preferences, and context.
 *
 * This is the working memory layer - immediate storage for working context.
 * Does NOT handle governance review, trust scoring, or verification.
 * That's the next layer built on top of this foundation.
 */

/**
 * Extract memorable facts from a user message.
 *
 * Uses simple heuristics to identify statements worth remembering:
 * - Personal information (name, location, job, family)
 * - Preferences and likes/dislikes
 * - Relationships and people
 * - Important context and facts
 *
 * @param {string} userMessage - The user's message
 * @param {Object} options - Options object
 * @param {Function} options.logger - Optional logger function
 * @returns {Array<Object>} Array of memory candidates: { content, confidence }
 */
function extractMemoriableFacts(userMessage, options = {}) {
  const { logger } = options;
  const facts = [];

  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    return facts;
  }

  const message = userMessage.trim();

  // Patterns for identifying memorable user statements
  const patterns = [
    // Personal information
    {
      pattern: /(?:my name is|i'm|i am|call me) ([a-zA-Z]+)/i,
      extract: (match) => `User's name is ${match[1]}`,
      confidence: 0.9
    },
    {
      pattern: /i live in ([^,.!?]+)/i,
      extract: (match) => `User lives in ${match[1].trim()}`,
      confidence: 0.8
    },
    {
      pattern: /i (?:work|am employed) (?:at|for|as) ([^,.!?]+)/i,
      extract: (match) => `User works ${match[1].trim()}`,
      confidence: 0.8
    },
    {
      pattern: /i am a ([^,.!?]+)/i,
      extract: (match) => `User is a ${match[1].trim()}`,
      confidence: 0.7
    },

    // Family and relationships
    {
      pattern: /my (?:brother|sister|son|daughter|mother|father|mom|dad|wife|husband|partner) (?:is )?([^,.!?]+)/i,
      extract: (match) => `User's ${match[0].split(' ')[1]} ${match[1].trim()}`,
      confidence: 0.8
    },
    {
      pattern: /([a-zA-Z]+) is my (?:brother|sister|son|daughter|mother|father|mom|dad|wife|husband|partner)/i,
      extract: (match) => `${match[1]} is user's ${match[0].split(' ').pop()}`,
      confidence: 0.8
    },

    // Preferences
    {
      pattern: /i (?:love|like|enjoy|prefer) ([^,.!?]+)/i,
      extract: (match) => `User likes ${match[1].trim()}`,
      confidence: 0.6
    },
    {
      pattern: /i (?:hate|dislike|can't stand) ([^,.!?]+)/i,
      extract: (match) => `User dislikes ${match[1].trim()}`,
      confidence: 0.6
    },

    // Important facts about user's situation
    {
      pattern: /i have (?:a |an )?([^,.!?]+)/i,
      extract: (match) => `User has ${match[1].trim()}`,
      confidence: 0.5
    },
    {
      pattern: /i am (?:currently )?([^,.!?]+)/i,
      extract: (match) => `User is ${match[1].trim()}`,
      confidence: 0.4
    }
  ];

  // Apply patterns to extract facts
  for (const { pattern, extract, confidence } of patterns) {
    const match = message.match(pattern);
    if (match) {
      try {
        const content = extract(match);
        if (content && content.length > 10 && content.length < 200) {
          facts.push({ content, confidence });
        }
      } catch (error) {
        if (logger) {
          logger.warn('memory.extraction.pattern_error', {
            pattern: pattern.toString(),
            error: error.message
          });
        }
      }
    }
  }

  // Filter out very generic or low-quality facts
  const filteredFacts = facts.filter(fact => {
    const content = fact.content.toLowerCase();
    return !content.includes('undefined') &&
           !content.includes('null') &&
           content.length >= 15; // Minimum meaningful length
  });

  if (logger && filteredFacts.length > 0) {
    logger.info('memory.extraction.completed', {
      message_length: message.length,
      facts_extracted: filteredFacts.length,
      avg_confidence: filteredFacts.reduce((sum, f) => sum + f.confidence, 0) / filteredFacts.length
    });
  }

  return filteredFacts;
}

module.exports = {
  extractMemoriableFacts,
};