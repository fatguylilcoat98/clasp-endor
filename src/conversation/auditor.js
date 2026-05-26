'use strict';
/*
 * Response auditor for clasp-endor.
 *
 * Ported from splendor/lib/response-auditor.js with credit to Christopher Hughes.
 * Uses Groq Llama-3.1-8b-instant to audit AI responses for consistency with
 * retrieved memories, catching potential fabrications or contradictions.
 *
 * The auditor is fail-open: if Groq is unavailable or the audit fails,
 * it returns { verdict: 'PASS', details: 'audit-unavailable' } to avoid
 * blocking legitimate responses.
 */

// Environment-based configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const AUDIT_DISABLED = process.env.AUDIT_DISABLED === 'true';

let groqClient = null;
let Groq = null;

// Safe import - fail gracefully if groq-sdk is not available
try {
  if (GROQ_API_KEY && !AUDIT_DISABLED) {
    Groq = require('groq-sdk');
    groqClient = new Groq({ apiKey: GROQ_API_KEY });
  }
} catch (importError) {
  // groq-sdk not available - will fail-open
}

function escapeJsonString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Audit a response draft against retrieved memories for consistency.
 *
 * @param {string} userMessage - The user's message
 * @param {string} responseDraft - The AI's draft response
 * @param {Object} options - Options object
 * @param {Array} options.memoryRows - Retrieved memory rows for context
 * @param {Function} options.logger - Optional logger function
 * @returns {Promise<Object>} - { verdict: 'PASS'|'FAIL', details: string, reason?: string }
 */
// Accept both logger shapes — the test-door wiring + conversation
// runtime pass an object `{info, warn, error}`, while early callers
// passed a `(level, event, fields)` function. Normalize to a single
// function so the rest of the auditor doesn't care which.
function normalizeLogger(raw) {
  if (typeof raw === 'function') return raw;
  if (raw && typeof raw === 'object') {
    return (level, event, fields) => {
      const fn = raw[level] || raw.info;
      if (typeof fn === 'function') fn.call(raw, event, fields);
    };
  }
  return null;
}

async function auditResponse(userMessage, responseDraft, options = {}) {
  const { memoryRows = [], logger: rawLogger } = options;
  const logger = normalizeLogger(rawLogger);

  // Fail-open if auditing is disabled or not configured
  if (AUDIT_DISABLED) {
    return { verdict: 'PASS', details: 'audit-disabled' };
  }

  if (!groqClient || !Groq) {
    if (logger) {
      const reason = !Groq ? 'groq-sdk not available' : 'GROQ_API_KEY not set';
      logger('warn', 'auditor.unavailable', { message: `${reason}, skipping audit` });
    }
    return { verdict: 'PASS', details: !Groq ? 'groq-sdk-unavailable' : 'no-groq-key' };
  }

  // Skip audit if no memories to check against
  if (!memoryRows || memoryRows.length === 0) {
    return { verdict: 'PASS', details: 'no-memories-to-audit' };
  }

  try {
    // Extract memory content for audit context
    const memoryContext = memoryRows.map(row => {
      return `Memory: ${row.content || ''}`;
    }).join('\n');

    const auditPrompt = `You are an AI response auditor. Your job is to check if an AI assistant's response is consistent with the provided memory context and doesn't fabricate information.

MEMORY CONTEXT:
${memoryContext}

USER MESSAGE: "${escapeJsonString(userMessage)}"

AI RESPONSE: "${escapeJsonString(responseDraft)}"

Analyze the AI response for:
1. Factual consistency with the provided memories
2. Any fabricated information not supported by memories
3. Contradictions with established facts in memories

Respond with ONLY a JSON object in this exact format:
{
  "verdict": "PASS" or "FAIL",
  "reason": "brief explanation of your verdict"
}`;

    const completion = await groqClient.chat.completions.create({
      messages: [{ role: 'user', content: auditPrompt }],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 200,
    });

    const auditText = completion.choices[0]?.message?.content?.trim();
    if (!auditText) {
      if (logger) {
        logger('warn', 'auditor.empty_response', {});
      }
      return { verdict: 'PASS', details: 'audit-empty-response' };
    }

    // Parse the JSON response
    let auditResult;
    try {
      auditResult = JSON.parse(auditText);
    } catch (parseError) {
      if (logger) {
        logger('warn', 'auditor.parse_error', {
          error: parseError.message,
          response: auditText.substring(0, 200)
        });
      }
      return { verdict: 'PASS', details: 'audit-parse-error' };
    }

    const verdict = auditResult.verdict === 'FAIL' ? 'FAIL' : 'PASS';
    const reason = auditResult.reason || 'no-reason-provided';

    if (logger) {
      logger('info', 'auditor.completed', {
        verdict,
        reason: reason.substring(0, 100), // Truncate for logging
        memory_count: memoryRows.length
      });
    }

    return {
      verdict,
      details: 'groq-audit-completed',
      reason
    };

  } catch (error) {
    if (logger) {
      logger('warn', 'auditor.error', {
        error_class: error.name || 'unknown',
        message: error.message?.substring(0, 100)
      });
    }

    // Fail-open: allow response even if audit fails
    return { verdict: 'PASS', details: 'audit-error-fail-open' };
  }
}

module.exports = {
  auditResponse,
};
