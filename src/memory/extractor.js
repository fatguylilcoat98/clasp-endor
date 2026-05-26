'use strict';
/*
 * Two-layer memory extraction for working memory system.
 *
 * Layer 1: Pattern-based extraction (fast, high-confidence)
 * Layer 2: AI-powered extraction (robust, catches subtle cases)
 *
 * Extracts user-stated facts for WORKING_ACTIVE memory storage.
 * Fail-open design: extraction failures never crash the conversation.
 */

// Import Groq for Layer 2 AI extraction
let Groq = null;
try {
  Groq = require('groq-sdk');
} catch (error) {
  // Groq not available - Layer 2 will fail-open
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
let groqClient = null;
if (Groq && GROQ_API_KEY) {
  groqClient = new Groq({ apiKey: GROQ_API_KEY });
}

/**
 * Layer 1: Pattern-based extraction (fast, high-confidence)
 * Catches obvious cases without AI calls.
 */
function extractWithPatterns(userMessage) {
  const facts = [];
  const message = userMessage.trim();

  const patterns = [
    // Explicit remember commands (highest confidence)
    {
      pattern: /(?:remember\s*(?:that\s*)?|don't\s*forget\s*(?:that\s*)?)\s*(.+)/i,
      extract: (match) => match[1].trim().replace(/^[,\s]+/, ''),
      confidence: 0.95
    },
    {
      pattern: /(?:please\s*)?remember\s*this\s*[:\-]?\s*(.+)/i,
      extract: (match) => match[1].trim(),
      confidence: 0.95
    },

    // Favorites and preferences (high confidence)
    {
      pattern: /my\s+favorite\s+([^,\s]+)\s+is\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User's favorite ${match[1]} is ${match[2].trim()}`,
      confidence: 0.9
    },
    {
      pattern: /my\s+([^,\s]+)\s+(?:of\s+choice|preference)\s+is\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User's preferred ${match[1]} is ${match[2].trim()}`,
      confidence: 0.85
    },

    // Personal information (high confidence)
    {
      pattern: /(?:my\s+name\s+is|i'm\s+called|call\s+me)\s+([a-zA-Z\s]+?)(?:[,.!?]|$)/i,
      extract: (match) => `User's name is ${match[1].trim()}`,
      confidence: 0.9
    },
    {
      pattern: /i\s+live\s+(?:in|at)\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User lives in ${match[1].trim()}`,
      confidence: 0.85
    },
    {
      pattern: /i\s+(?:work\s+(?:at|for)|am\s+employed\s+(?:at|by))\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User works at ${match[1].trim()}`,
      confidence: 0.8
    },
    {
      pattern: /i\s+am\s+a\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User is a ${match[1].trim()}`,
      confidence: 0.75
    },

    // Relationships (high confidence)
    {
      pattern: /my\s+(wife|husband|partner|spouse|girlfriend|boyfriend)\s+(?:is\s+)?(?:named\s+)?([a-zA-Z]+)/i,
      extract: (match) => `User's ${match[1]} is named ${match[2]}`,
      confidence: 0.85
    },
    {
      pattern: /my\s+(mother|father|mom|dad|son|daughter|brother|sister)\s+(?:is\s+)?(?:named\s+)?([a-zA-Z]+)/i,
      extract: (match) => `User's ${match[1]} is named ${match[2]}`,
      confidence: 0.85
    },
    {
      pattern: /([a-zA-Z]+)\s+is\s+my\s+(wife|husband|partner|mother|father|mom|dad|son|daughter|brother|sister)/i,
      extract: (match) => `${match[1]} is user's ${match[2]}`,
      confidence: 0.85
    },

    // Possessions and properties
    {
      pattern: /my\s+([^,\s]+)\s+is\s+(?:a\s+|an\s+)?(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User's ${match[1]} is ${match[2].trim()}`,
      confidence: 0.7
    },
    {
      pattern: /i\s+have\s+(?:a\s+|an\s+)?(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User has ${match[1].trim()}`,
      confidence: 0.6
    },

    // Preferences and dislikes
    {
      pattern: /i\s+(?:really\s+)?(?:love|like|enjoy|prefer)\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User likes ${match[1].trim()}`,
      confidence: 0.6
    },
    {
      pattern: /i\s+(?:really\s+)?(?:hate|dislike|can't\s+stand|don't\s+like)\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `User dislikes ${match[1].trim()}`,
      confidence: 0.6
    }
  ];

  for (const { pattern, extract, confidence } of patterns) {
    const match = message.match(pattern);
    if (match) {
      try {
        const content = extract(match);
        if (content && content.length >= 10 && content.length <= 200) {
          // Avoid duplicates in pattern layer
          if (!facts.some(f => f.content.toLowerCase() === content.toLowerCase())) {
            facts.push({ content, confidence });
          }
        }
      } catch (error) {
        // Skip malformed patterns
      }
    }
  }

  return facts.filter(fact => {
    const content = fact.content.toLowerCase();
    return !content.includes('undefined') &&
           !content.includes('null') &&
           content.length >= 10;
  });
}

/**
 * Layer 2: AI-powered extraction using Groq
 * Catches subtle user-stated facts that patterns missed.
 */
async function extractWithAI(userMessage, patternFacts = [], logger = null) {
  if (!groqClient) {
    if (logger) {
      logger.info('memory.extraction.ai_unavailable', {
        reason: Groq ? 'no_api_key' : 'groq_sdk_missing'
      });
    }
    return [];
  }

  try {
    // Build exclusion list from pattern facts
    const alreadyExtracted = patternFacts.map(f => f.content.toLowerCase());
    const exclusionText = alreadyExtracted.length > 0
      ? `\n\nALREADY EXTRACTED (do not repeat): ${alreadyExtracted.join('; ')}`
      : '';

    const extractionPrompt = `You are a fact extraction specialist. Extract ONLY clearly user-stated facts about themselves from this message.

EXTRACT ONLY IF:
- User explicitly states a fact about themselves
- User explicitly asks to remember something
- Clear personal information, preferences, or relationships

DO NOT EXTRACT:
- Questions the user asks
- Hypotheticals or uncertainties
- General conversation or pleasantries
- Facts about other people (unless their relationship to user)
- Your responses or suggestions
- Implied or inferred information

USER MESSAGE: "${userMessage}"${exclusionText}

Return a JSON array of facts with confidence scores 0.0-1.0:
[{"fact": "clear factual statement", "confidence": 0.8}]

If no clear user-stated facts, return: []`;

    const completion = await groqClient.chat.completions.create({
      messages: [{ role: 'user', content: extractionPrompt }],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 300,
    });

    const aiResponse = completion.choices[0]?.message?.content?.trim();
    if (!aiResponse) return [];

    // Parse AI response
    let aiFacts;
    try {
      aiFacts = JSON.parse(aiResponse);
    } catch (parseError) {
      if (logger) {
        logger.warn('memory.extraction.ai_parse_error', {
          response: aiResponse.substring(0, 100),
          error: parseError.message
        });
      }
      return [];
    }

    if (!Array.isArray(aiFacts)) return [];

    // Convert AI facts to our format and de-duplicate
    return aiFacts
      .filter(af => af.fact && typeof af.fact === 'string' && af.confidence)
      .map(af => ({
        content: af.fact.trim(),
        confidence: Math.max(0.1, Math.min(1.0, Number(af.confidence) || 0.5))
      }))
      .filter(fact => {
        // Remove duplicates vs pattern facts
        const content = fact.content.toLowerCase();
        return !alreadyExtracted.some(existing =>
          content.includes(existing) || existing.includes(content)
        );
      })
      .filter(fact => fact.content.length >= 10 && fact.content.length <= 300);

  } catch (error) {
    if (logger) {
      logger.warn('memory.extraction.ai_error', {
        error_class: error.name || 'unknown',
        message: error.message?.substring(0, 100)
      });
    }
    return [];
  }
}

/**
 * Main extraction function: Two-layer approach
 * Layer 1 (patterns) + Layer 2 (AI) with deduplication
 */
async function extractMemoriableFacts(userMessage, options = {}) {
  const { logger } = options;

  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    return [];
  }

  try {
    // Layer 1: Pattern extraction (fast, high-confidence)
    const patternFacts = extractWithPatterns(userMessage);

    // Layer 2: AI extraction (robust, catches what patterns miss)
    const aiFacts = await extractWithAI(userMessage, patternFacts, logger);

    // Combine results
    const allFacts = [...patternFacts, ...aiFacts];

    if (logger) {
      logger.info('memory.extraction.completed', {
        message_length: userMessage.length,
        pattern_facts: patternFacts.length,
        ai_facts: aiFacts.length,
        total_facts: allFacts.length,
        avg_confidence: allFacts.length > 0
          ? allFacts.reduce((sum, f) => sum + f.confidence, 0) / allFacts.length
          : 0
      });
    }

    return allFacts;

  } catch (error) {
    if (logger) {
      logger.warn('memory.extraction.error', {
        error_class: error.name || 'unknown',
        message: error.message?.substring(0, 100)
      });
    }
    // Fail-open: return empty array if extraction completely fails
    return [];
  }
}

module.exports = {
  extractMemoriableFacts,
  extractWithPatterns,
  extractWithAI,
};