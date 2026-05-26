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

    // Relationships (high confidence). Negative lookaheads on the
    // name capture prevent "my brother is not Daniel" from extracting
    // "User's brother is named not" / "User's brother is not Daniel"
    // as affirmative facts — those false-positive extractions
    // contaminated retrieval against any natural-language correction
    // (see live test).
    {
      pattern: /my\s+(wife|husband|partner|spouse|girlfriend|boyfriend)\s+is\s+(?:named\s+)?(?!not\b)([a-zA-Z]+)/i,
      extract: (match) => `User's ${match[1]} is named ${match[2]}`,
      confidence: 0.85
    },
    {
      pattern: /my\s+(mother|father|mom|dad|son|daughter|brother|sister)\s+is\s+(?:named\s+)?(?!not\b)([a-zA-Z]+)/i,
      extract: (match) => `User's ${match[1]} is named ${match[2]}`,
      confidence: 0.85
    },
    {
      pattern: /^(?!not\b)([a-zA-Z]+)\s+is\s+my\s+(wife|husband|partner|mother|father|mom|dad|son|daughter|brother|sister)/i,
      extract: (match) => `${match[1]} is user's ${match[2]}`,
      confidence: 0.85
    },

    // Possessions and properties. The negative lookahead excludes
    // "is not" — see the relationship patterns above for why.
    {
      pattern: /my\s+([^,\s]+)\s+is(?!\s+not)\s+(?:a\s+|an\s+)?(.+?)(?:[,.!?]|$)/i,
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
    },

    // Corrections and negations (high confidence)
    {
      pattern: /(?:that's\s+(?:wrong|incorrect|not\s+right)|i\s+was\s+wrong|(?:no|nope),?\s+(?:i\s+)?(?:don't|do\s+not))\s+(?:have|own)\s+(?:a\s+|an\s+)?(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `CORRECTION: User does not have ${match[1].trim()}`,
      confidence: 0.9
    },
    {
      pattern: /^(?:i\s+)?(?:don't|do\s+not)\s+(?:have|own)\s+(?:a\s+|an\s+)?(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `CORRECTION: User does not have ${match[1].trim()}`,
      confidence: 0.85
    },
    {
      pattern: /(?:actually,?\s+)?(?:i\s+)?(?:don't|do\s+not|never)\s+(?:have|own)\s+(?:a\s+|an\s+)?(brother|sister|wife|husband|partner|mother|father|mom|dad|son|daughter)(?:\s+(?:named\s+|called\s+)?(.+?))?(?:[,.!?]|$)/i,
      extract: (match) => {
        if (match[2]) {
          return `CORRECTION: User does not have ${match[1]} named ${match[2].trim()}`;
        } else {
          return `CORRECTION: User does not have ${match[1]}`;
        }
      },
      confidence: 0.95
    },
    // Natural-language correction: "<Name> is not (actually) my <relationship>"
    // Optionally prefixed with "Correction:" / "Actually,". This is the
    // phrasing the operator's live test uncovered as a retrieval
    // integrity bug (extractor previously emitted nothing, no
    // CORRECTION row got stored, the seeded fact stayed canonical).
    {
      pattern: /^(?:correction\s*[:\-]?\s*)?(?:actually,?\s+)?([a-zA-Z][a-zA-Z\s'\-]*?)\s+is\s+not\s+(?:actually\s+)?my\s+(brother|sister|wife|husband|partner|mother|father|mom|dad|son|daughter|spouse|girlfriend|boyfriend)(?:[,.!?]|$)/i,
      extract: (match) => `CORRECTION: User does not have ${match[2].toLowerCase()} named ${match[1].trim()}`,
      confidence: 0.95
    },
    // Reverse phrasing: "my <relationship> is not <Name>" — catches
    // "my brother is not Daniel" / "my sister is not Maria".
    {
      pattern: /^(?:correction\s*[:\-]?\s*)?(?:actually,?\s+)?my\s+(brother|sister|wife|husband|partner|mother|father|mom|dad|son|daughter|spouse|girlfriend|boyfriend)\s+is\s+not\s+(?:named\s+|called\s+)?([a-zA-Z][a-zA-Z\s'\-]*?)(?:[,.!?]|$)/i,
      extract: (match) => `CORRECTION: User does not have ${match[1].toLowerCase()} named ${match[2].trim()}`,
      confidence: 0.95
    },
    // Generic "Correction: <anything>" prefix that doesn't fit the
    // structured patterns above. Lower confidence because the content
    // is unparsed, but the prefix marks it as a correction so the
    // writer's correction loop will run a substring-based search.
    {
      pattern: /^correction\s*[:\-]\s*(.+?)(?:[.!?]|$)/i,
      extract: (match) => `CORRECTION: ${match[1].trim()}`,
      confidence: 0.85
    },
    {
      pattern: /(?:forget|ignore)\s+(?:what\s+i\s+said\s+about|that\s+i\s+mentioned)\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `RETRACTION: Ignore previous statements about ${match[1].trim()}`,
      confidence: 0.9
    },
    {
      pattern: /(?:that's\s+(?:wrong|incorrect|not\s+true)|i\s+misspoke|i\s+made\s+a\s+mistake)(?:\s*[,.]?\s*)?(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `CORRECTION: Previous statement about ${match[1].trim()} was incorrect`,
      confidence: 0.85
    },
    {
      pattern: /(?:actually,?\s+)?(?:i\s+)?(?:don't|do\s+not|never)\s+(?:like|enjoy|love|prefer)\s+(.+?)(?:[,.!?]|$)/i,
      extract: (match) => `CORRECTION: User does not like ${match[1].trim()}`,
      confidence: 0.8
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

  const filteredFacts = facts.filter(fact => {
    const content = fact.content.toLowerCase();
    return !content.includes('undefined') &&
           !content.includes('null') &&
           content.length >= 10;
  });

  // Ensure we always return an array
  return Array.isArray(filteredFacts) ? filteredFacts : [];
}

/**
 * Layer 2: AI-powered extraction using Groq
 * Catches subtle user-stated facts that patterns missed.
 */
async function extractWithAI(userMessage, patternFacts = [], logger = null) {
  // Log comprehensive API status
  if (logger) {
    logger.info('memory.extraction.ai_status_check', {
      groq_sdk_available: !!Groq,
      groq_api_key_available: !!GROQ_API_KEY,
      groq_client_ready: !!groqClient,
      pattern_facts_count: Array.isArray(patternFacts) ? patternFacts.length : 'not_array'
    });
  }

  if (!groqClient) {
    if (logger) {
      logger.info('memory.extraction.ai_unavailable', {
        reason: Groq ? 'no_api_key' : 'groq_sdk_missing',
        groq_sdk: !!Groq,
        api_key: !!GROQ_API_KEY
      });
    }
    return [];
  }

  if (logger) {
    logger.info('memory.extraction.ai_layer_starting', {
      message_length: userMessage.length,
      excluded_facts: Array.isArray(patternFacts) ? patternFacts.length : 0
    });
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
    if (!aiResponse) {
      if (logger) {
        logger.info('memory.extraction.ai_empty_response', {});
      }
      return [];
    }

    if (logger) {
      logger.info('memory.extraction.ai_response_received', {
        response_length: aiResponse.length,
        response_preview: aiResponse.substring(0, 200)
      });
    }

    // Parse AI response with comprehensive error handling
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(aiResponse);
      if (logger) {
        logger.info('memory.extraction.ai_json_parsed', {
          type: typeof parsedResponse,
          is_array: Array.isArray(parsedResponse),
          structure: Array.isArray(parsedResponse) ? 'array' : (typeof parsedResponse === 'object' && parsedResponse ? Object.keys(parsedResponse).join(',') : typeof parsedResponse)
        });
      }
    } catch (parseError) {
      if (logger) {
        logger.warn('memory.extraction.ai_parse_error', {
          response: aiResponse.substring(0, 100),
          error: parseError.message
        });
      }
      return [];
    }

    // Normalize AI response to array of facts
    let aiFacts = [];
    if (Array.isArray(parsedResponse)) {
      aiFacts = parsedResponse;
    } else if (parsedResponse && typeof parsedResponse === 'object') {
      // Handle responses like {facts: [...]} or {data: [...]}
      if (Array.isArray(parsedResponse.facts)) {
        aiFacts = parsedResponse.facts;
      } else if (Array.isArray(parsedResponse.data)) {
        aiFacts = parsedResponse.data;
      } else if (Array.isArray(parsedResponse.results)) {
        aiFacts = parsedResponse.results;
      } else {
        if (logger) {
          logger.warn('memory.extraction.ai_unexpected_object', {
            keys: Object.keys(parsedResponse).join(','),
            sample: JSON.stringify(parsedResponse).substring(0, 100)
          });
        }
        return [];
      }
    } else {
      if (logger) {
        logger.warn('memory.extraction.ai_unexpected_type', {
          type: typeof parsedResponse,
          value: String(parsedResponse).substring(0, 100)
        });
      }
      return [];
    }

    // Ensure we have an array at this point
    if (!Array.isArray(aiFacts)) {
      if (logger) {
        logger.warn('memory.extraction.ai_not_array_after_normalization', {
          type: typeof aiFacts,
          value: String(aiFacts).substring(0, 100)
        });
      }
      return [];
    }

    if (logger) {
      logger.info('memory.extraction.ai_facts_normalized', {
        raw_count: aiFacts.length,
        sample_fact: aiFacts.length > 0 ? JSON.stringify(aiFacts[0]).substring(0, 100) : 'none'
      });
    }

    // Convert AI facts to our format with error handling
    try {
      const processedFacts = aiFacts
        .filter(af => af && typeof af === 'object' && af.fact && typeof af.fact === 'string' && af.confidence)
        .map(af => ({
          content: af.fact.trim(),
          confidence: Math.max(0.1, Math.min(1.0, Number(af.confidence) || 0.5))
        }))
        .filter(fact => fact && fact.content && fact.content.length >= 10 && fact.content.length <= 300)
        .filter(fact => {
          // Remove duplicates vs pattern facts
          const content = fact.content.toLowerCase();
          return !alreadyExtracted.some(existing =>
            content.includes(existing) || existing.includes(content)
          );
        });

      // Final safety check - ensure we return an array
      const safeFacts = Array.isArray(processedFacts) ? processedFacts : [];

      if (logger) {
        logger.info('memory.extraction.ai_facts_processed', {
          input_count: aiFacts.length,
          output_count: safeFacts.length,
          facts: safeFacts.map(f => ({ content: f.content.substring(0, 50), confidence: f.confidence }))
        });
      }

      return safeFacts;

    } catch (processingError) {
      if (logger) {
        logger.warn('memory.extraction.ai_processing_error', {
          error_class: processingError.name || 'unknown',
          message: processingError.message,
          ai_facts_type: typeof aiFacts,
          ai_facts_length: Array.isArray(aiFacts) ? aiFacts.length : 'not_array'
        });
      }
      return [];
    }

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
    const safePatternFacts = Array.isArray(patternFacts) ? patternFacts : [];

    if (logger) {
      logger.info('memory.extraction.pattern_layer_completed', {
        raw_result_type: typeof patternFacts,
        raw_result_array: Array.isArray(patternFacts),
        safe_facts_count: safePatternFacts.length
      });
    }

    // Layer 2: AI extraction (robust, catches what patterns miss)
    const aiFacts = await extractWithAI(userMessage, safePatternFacts, logger);
    const safeAiFacts = Array.isArray(aiFacts) ? aiFacts : [];

    if (logger) {
      logger.info('memory.extraction.ai_layer_completed', {
        raw_result_type: typeof aiFacts,
        raw_result_array: Array.isArray(aiFacts),
        safe_facts_count: safeAiFacts.length
      });
    }

    // Combine results with additional safety
    let allFacts = [];
    try {
      allFacts = [...safePatternFacts, ...safeAiFacts];

      // Final safety check - ensure all elements are valid fact objects
      allFacts = allFacts.filter(fact =>
        fact &&
        typeof fact === 'object' &&
        typeof fact.content === 'string' &&
        typeof fact.confidence === 'number'
      );
    } catch (mergeError) {
      if (logger) {
        logger.warn('memory.extraction.merge_error', {
          error_class: mergeError.name || 'unknown',
          message: mergeError.message,
          pattern_facts_type: typeof safePatternFacts,
          ai_facts_type: typeof safeAiFacts
        });
      }
      allFacts = [];
    }

    if (logger) {
      logger.info('memory.extraction.completed', {
        message_length: userMessage.length,
        pattern_facts: safePatternFacts.length,
        ai_facts: safeAiFacts.length,
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
