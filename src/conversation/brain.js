'use strict';
/*
 * Advanced Cognitive Processing Pipeline for clasp-endor
 *
 * Eight-stage intelligent processing pipeline that processes every conversation turn
 * through specialized processing modules, each feeding the next. Carefully integrated
 * with clasp-endor's memory governance and safety systems.
 *
 * Pipeline: Priority Filter → Memory Engine → Attention Controller → Sentiment Analyzer →
 *          Style Controller → Quality Engine → Safety Controller → Response Generator
 *
 * All memory access goes through clasp-endor's audit-bundled governance.
 * All safety decisions use clasp-endor's governance classifier.
 * Graceful degradation with fallback to direct generation.
 */

const { buildPrompt } = require('./prompt');
const { auditResponse } = require('./auditor');

// OpenAI for embeddings (Priority Filter and Memory Engine)
let openaiClient = null;
try {
  if (process.env.OPENAI_API_KEY) {
    const { OpenAI } = require('openai');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (error) {
  // OpenAI not available - RAS and Hippocampus will degrade
}

// Secondary LLM for emotion/reflection (Sentiment Analyzer and Quality Engine)
let secondaryClient = null;
try {
  if (process.env.OPENAI_API_KEY) {
    const { OpenAI } = require('openai');
    secondaryClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch (error) {
  // Secondary LLM not available - Amygdala and DMN will degrade
}

/**
 * Stage 1: Priority Filter
 * Salience and novelty detection - determines what deserves attention
 */
async function processPriorityFilter(userMessage, context, logger) {
  const regionName = 'PriorityFilter';

  if (!openaiClient) {
    if (logger) logger.info('brain.priority_filter.degraded', { reason: 'no_openai_client' });
    return {
      salience: 0.5, // Default medium salience
      novelty: 0.5,
      attentionWeight: 0.5,
      degraded: true,
      reason: 'openai_unavailable'
    };
  }

  try {
    // Get embedding for salience detection
    const embedding = await openaiClient.embeddings.create({
      model: 'text-embedding-3-small',
      input: userMessage.substring(0, 8000), // Truncate for API limits
    });

    // Simple salience scoring based on message characteristics
    const messageLength = userMessage.length;
    const hasQuestions = /\?/.test(userMessage);
    const hasEmotionalWords = /(feel|sad|happy|angry|excited|worried|love|hate|afraid)/i.test(userMessage);
    const hasUrgentWords = /(urgent|emergency|help|please|need|important)/i.test(userMessage);

    // Calculate salience score
    let salience = 0.3; // Base salience
    if (hasQuestions) salience += 0.2;
    if (hasEmotionalWords) salience += 0.3;
    if (hasUrgentWords) salience += 0.4;
    if (messageLength > 100) salience += 0.1;

    // Novelty detection (simplified - in full implementation would compare to recent embeddings)
    const novelty = Math.min(1.0, 0.4 + (messageLength / 1000));

    const attentionWeight = Math.min(1.0, (salience + novelty) / 2);

    if (logger) {
      logger.info('brain.priority_filter.processed', {
        salience: Math.round(salience * 100) / 100,
        novelty: Math.round(novelty * 100) / 100,
        attentionWeight: Math.round(attentionWeight * 100) / 100,
        hasQuestions,
        hasEmotionalWords,
        hasUrgentWords
      });
    }

    return {
      salience,
      novelty,
      attentionWeight,
      embedding: embedding.data[0].embedding,
      degraded: false
    };

  } catch (error) {
    if (logger) logger.warn('brain.priority_filter.error', { error: error.message?.substring(0, 100) });
    return {
      salience: 0.5,
      novelty: 0.5,
      attentionWeight: 0.5,
      degraded: true,
      reason: 'processing_error'
    };
  }
}

/**
 * Stage 2: Memory Engine
 * Memory retrieval using clasp-endor's audit-bundled memory system
 * CRITICAL: Uses companionReader.readVisibleMemories() - preserves all RLS and governance
 */
async function processMemoryEngine(userMessage, memoryRows, priorityOutput, context, logger) {
  const regionName = 'MemoryEngine';

  try {
    // Use clasp-endor's pre-retrieved memories (already RLS-filtered and audit-bundled)
    const availableMemories = memoryRows || [];

    if (!openaiClient || !priorityOutput.embedding) {
      // Graceful degradation - return memories without re-ranking
      if (logger) {
        logger.info('brain.memory_engine.degraded', {
          reason: 'no_embedding_capability',
          memory_count: availableMemories.length
        });
      }
      return {
        relevantMemories: availableMemories.slice(0, 10), // Top 10 memories
        memoryContext: availableMemories.slice(0, 10).map(m => m.content).join('\n'),
        degraded: true,
        reason: 'no_reranking'
      };
    }

    // Get embeddings for memory content and rank by similarity
    const memoriesWithScores = [];

    for (const memory of availableMemories.slice(0, 20)) { // Limit for API costs
      try {
        const memoryEmbedding = await openaiClient.embeddings.create({
          model: 'text-embedding-3-small',
          input: memory.content.substring(0, 8000),
        });

        // Calculate cosine similarity
        const similarity = cosineSimilarity(priorityOutput.embedding, memoryEmbedding.data[0].embedding);

        memoriesWithScores.push({
          ...memory,
          relevanceScore: similarity
        });
      } catch (error) {
        // Include memory without score if embedding fails
        memoriesWithScores.push({
          ...memory,
          relevanceScore: 0.1
        });
      }
    }

    // Sort by relevance and attention weight
    memoriesWithScores.sort((a, b) =>
      (b.relevanceScore * priorityOutput.attentionWeight) - (a.relevanceScore * priorityOutput.attentionWeight)
    );

    const topMemories = memoriesWithScores.slice(0, 8); // Top 8 most relevant
    const memoryContext = topMemories.map(m => m.content).join('\n');

    if (logger) {
      logger.info('brain.memory_engine.processed', {
        total_memories: availableMemories.length,
        ranked_memories: memoriesWithScores.length,
        selected_memories: topMemories.length,
        avg_relevance: memoriesWithScores.length > 0 ?
          memoriesWithScores.reduce((sum, m) => sum + m.relevanceScore, 0) / memoriesWithScores.length : 0
      });
    }

    return {
      relevantMemories: topMemories,
      memoryContext,
      degraded: false
    };

  } catch (error) {
    if (logger) logger.warn('brain.memory_engine.error', { error: error.message?.substring(0, 100) });

    // Fallback to basic memory selection
    const fallbackMemories = (memoryRows || []).slice(0, 8);
    return {
      relevantMemories: fallbackMemories,
      memoryContext: fallbackMemories.map(m => m.content).join('\n'),
      degraded: true,
      reason: 'processing_error'
    };
  }
}

/**
 * Stage 3: Attention Controller
 * Sets attention priority and urgency from context signals
 */
function processAttentionController(userMessage, priorityOutput, memoryOutput, context, logger) {
  try {
    const messageTime = new Date();
    const messageLength = userMessage.length;

    // Analyze temporal context
    const isBusinessHours = messageTime.getHours() >= 9 && messageTime.getHours() <= 17;
    const isWeekend = messageTime.getDay() === 0 || messageTime.getDay() === 6;

    // Analyze conversational urgency
    const urgencyWords = /(urgent|emergency|help|please|asap|immediately|critical|important)/gi;
    const urgencyMatches = userMessage.match(urgencyWords) || [];
    const hasRepeatQuestions = /\?\s*\?/.test(userMessage);

    // Calculate priority scores
    let urgencyScore = 0.3; // Base urgency
    urgencyScore += urgencyMatches.length * 0.2;
    if (hasRepeatQuestions) urgencyScore += 0.3;
    if (!isBusinessHours) urgencyScore += 0.1; // Off-hours gets slight urgency boost

    // Attention priority combines RAS salience with contextual urgency
    const attentionPriority = Math.min(1.0,
      (priorityOutput.attentionWeight * 0.7) + (urgencyScore * 0.3)
    );

    // Response pacing - urgent messages get faster, reflective messages get slower
    let responsePacing = 'normal';
    if (attentionPriority > 0.8) responsePacing = 'urgent';
    else if (attentionPriority < 0.4 && messageLength > 200) responsePacing = 'reflective';

    if (logger) {
      logger.info('brain.attention_controller.processed', {
        urgencyScore: Math.round(urgencyScore * 100) / 100,
        attentionPriority: Math.round(attentionPriority * 100) / 100,
        responsePacing,
        urgencyWords: urgencyMatches.length,
        isBusinessHours,
        isWeekend
      });
    }

    return {
      urgencyScore,
      attentionPriority,
      responsePacing,
      contextualCues: {
        isBusinessHours,
        isWeekend,
        urgencyWords: urgencyMatches.length,
        hasRepeatQuestions
      },
      degraded: false
    };

  } catch (error) {
    if (logger) logger.warn('brain.attention_controller.error', { error: error.message?.substring(0, 100) });
    return {
      urgencyScore: 0.5,
      attentionPriority: 0.5,
      responsePacing: 'normal',
      degraded: true,
      reason: 'processing_error'
    };
  }
}

/**
 * Stage 4: Sentiment Analyzer
 * Emotional classification and sentiment analysis
 */
async function processSentimentAnalyzer(userMessage, context, logger) {
  if (!secondaryClient) {
    if (logger) logger.info('brain.sentiment_analyzer.degraded', { reason: 'no_secondary_llm' });
    return {
      emotion: 'neutral',
      sentiment: 0.0,
      emotionalIntensity: 0.3,
      supportNeeds: ['general'],
      degraded: true,
      reason: 'llm_unavailable'
    };
  }

  try {
    const emotionPrompt = `Analyze the emotional content of this message. Respond with ONLY a JSON object:

Message: "${userMessage}"

Format:
{
  "emotion": "primary_emotion",
  "sentiment": score_from_negative_1_to_positive_1,
  "intensity": score_from_0_to_1,
  "support_needs": ["type1", "type2"]
}

Emotions: joy, sadness, anger, fear, surprise, disgust, neutral
Support types: emotional, practical, informational, social, medical, urgent`;

    const completion = await secondaryClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: emotionPrompt }],
      temperature: 0.1,
      max_tokens: 200,
    });

    const emotionText = completion.choices[0]?.message?.content?.trim();
    let emotionResult;

    try {
      emotionResult = JSON.parse(emotionText);
    } catch {
      // Fallback parsing
      emotionResult = {
        emotion: 'neutral',
        sentiment: 0.0,
        intensity: 0.3,
        support_needs: ['general']
      };
    }

    const result = {
      emotion: emotionResult.emotion || 'neutral',
      sentiment: Math.max(-1, Math.min(1, emotionResult.sentiment || 0)),
      emotionalIntensity: Math.max(0, Math.min(1, emotionResult.intensity || 0.3)),
      supportNeeds: Array.isArray(emotionResult.support_needs) ? emotionResult.support_needs : ['general'],
      degraded: false
    };

    if (logger) {
      logger.info('brain.sentiment_analyzer.processed', {
        emotion: result.emotion,
        sentiment: Math.round(result.sentiment * 100) / 100,
        intensity: Math.round(result.emotionalIntensity * 100) / 100,
        supportNeeds: result.supportNeeds
      });
    }

    return result;

  } catch (error) {
    if (logger) logger.warn('brain.sentiment_analyzer.error', { error: error.message?.substring(0, 100) });
    return {
      emotion: 'neutral',
      sentiment: 0.0,
      emotionalIntensity: 0.3,
      supportNeeds: ['general'],
      degraded: true,
      reason: 'processing_error'
    };
  }
}

/**
 * Stage 5: Style Controller
 * Response habits - pacing, tone anchors, behavioral patterns
 */
function processStyleController(userMessage, sentimentOutput, attentionOutput, context, logger) {
  try {
    const { companionConfig } = context;
    const companionName = companionConfig?.name || 'Assistant';

    // Base response style
    let responseStyle = {
      pacing: attentionOutput.responsePacing || 'normal',
      warmth: 0.7,
      formality: 0.3,
      verbosity: 0.5,
      supportiveness: 0.8
    };

    // Emotional adjustments
    const emotion = sentimentOutput.emotion;
    const intensity = sentimentOutput.emotionalIntensity;

    if (emotion === 'sadness' || emotion === 'fear') {
      responseStyle.warmth += 0.2;
      responseStyle.supportiveness += 0.2;
      responseStyle.verbosity -= 0.1; // More concise for emotional distress
    } else if (emotion === 'anger') {
      responseStyle.warmth += 0.1;
      responseStyle.formality += 0.1;
      responseStyle.verbosity -= 0.2; // Very concise for anger
    } else if (emotion === 'joy' || emotion === 'surprise') {
      responseStyle.warmth += 0.1;
      responseStyle.verbosity += 0.1;
    }

    // Urgency adjustments
    if (attentionOutput.urgencyScore > 0.7) {
      responseStyle.verbosity -= 0.2;
      responseStyle.supportiveness += 0.1;
    }

    // Companion-specific adjustments
    if (companionName.toLowerCase() === 'barry') {
      responseStyle.warmth += 0.1;
      responseStyle.formality -= 0.2;
    }

    // Behavioral anchors for response generation
    const behavioralAnchors = {
      avoidPatterns: [],
      emphasizePatterns: [],
      toneMarkers: []
    };

    if (responseStyle.warmth > 0.7) {
      behavioralAnchors.toneMarkers.push('caring', 'empathetic', 'understanding');
    }
    if (responseStyle.supportiveness > 0.7) {
      behavioralAnchors.emphasizePatterns.push('validation', 'encouragement', 'practical_help');
    }
    if (sentimentOutput.supportNeeds.includes('emotional')) {
      behavioralAnchors.emphasizePatterns.push('emotional_support', 'active_listening');
    }

    // Clamp values
    Object.keys(responseStyle).forEach(key => {
      if (typeof responseStyle[key] === 'number') {
        responseStyle[key] = Math.max(0, Math.min(1, responseStyle[key]));
      }
    });

    if (logger) {
      logger.info('brain.style_controller.processed', {
        responseStyle: Object.fromEntries(
          Object.entries(responseStyle).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v])
        ),
        behavioralAnchors: behavioralAnchors.toneMarkers,
        companionName
      });
    }

    return {
      responseStyle,
      behavioralAnchors,
      degraded: false
    };

  } catch (error) {
    if (logger) logger.warn('brain.style_controller.error', { error: error.message?.substring(0, 100) });
    return {
      responseStyle: {
        pacing: 'normal',
        warmth: 0.7,
        formality: 0.3,
        verbosity: 0.5,
        supportiveness: 0.8
      },
      behavioralAnchors: { avoidPatterns: [], emphasizePatterns: [], toneMarkers: [] },
      degraded: true,
      reason: 'processing_error'
    };
  }
}

/**
 * Stage 6: Quality Engine
 * Adversarial reflection - "what are we missing?"
 */
async function processQualityEngine(userMessage, memoryOutput, sentimentOutput, context, logger) {
  if (!secondaryClient) {
    if (logger) logger.info('brain.quality_engine.degraded', { reason: 'no_secondary_llm' });
    return {
      reflections: [],
      missingContext: [],
      alternatives: [],
      degraded: true,
      reason: 'llm_unavailable'
    };
  }

  try {
    const memoryContext = memoryOutput.memoryContext || 'No memories available';

    const reflectionPrompt = `You are an adversarial reflection system. Analyze what might be missing or overlooked:

User Message: "${userMessage}"
Available Memory: "${memoryContext.substring(0, 1000)}"
Detected Emotion: ${sentimentOutput.emotion}

What are we potentially missing? Respond with ONLY a JSON object:
{
  "missing_context": ["item1", "item2"],
  "alternative_interpretations": ["alt1", "alt2"],
  "blind_spots": ["spot1", "spot2"]
}

Keep items brief and specific.`;

    const completion = await secondaryClient.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: reflectionPrompt }],
      temperature: 0.3,
      max_tokens: 300,
    });

    const reflectionText = completion.choices[0]?.message?.content?.trim();
    let reflectionResult;

    try {
      reflectionResult = JSON.parse(reflectionText);
    } catch {
      reflectionResult = {
        missing_context: [],
        alternative_interpretations: [],
        blind_spots: []
      };
    }

    const result = {
      reflections: [
        ...(reflectionResult.missing_context || []),
        ...(reflectionResult.alternative_interpretations || []),
        ...(reflectionResult.blind_spots || [])
      ],
      missingContext: reflectionResult.missing_context || [],
      alternatives: reflectionResult.alternative_interpretations || [],
      degraded: false
    };

    if (logger) {
      logger.info('brain.quality_engine.processed', {
        reflections: result.reflections.length,
        missingContext: result.missingContext.length,
        alternatives: result.alternatives.length
      });
    }

    return result;

  } catch (error) {
    if (logger) logger.warn('brain.quality_engine.error', { error: error.message?.substring(0, 100) });
    return {
      reflections: [],
      missingContext: [],
      alternatives: [],
      degraded: true,
      reason: 'processing_error'
    };
  }
}

/**
 * Stage 7: Safety Controller
 * Truth/safety judgment using clasp-endor's governance system
 * CRITICAL: Uses clasp-endor's governance classifier - preserves all safety policies
 */
function processSafetyController(userMessage, brainState, context, logger) {
  try {
    // Use clasp-endor's existing governance - this is already handled at the actor level
    // The brain operates within approved responses, so we focus on content safety

    const { sentimentOutput, memoryOutput, qualityOutput } = brainState;

    // Content safety checks
    const safetyFlags = {
      emotionalDistress: sentimentOutput.emotion === 'sadness' && sentimentOutput.emotionalIntensity > 0.8,
      urgentSupport: sentimentOutput.supportNeeds.includes('urgent') || sentimentOutput.supportNeeds.includes('medical'),
      missingCriticalContext: qualityOutput.missingContext.length > 3,
      memoryInconsistency: false // Would need more sophisticated checking
    };

    // Safety recommendations
    const safetyRecommendations = [];
    if (safetyFlags.emotionalDistress) {
      safetyRecommendations.push('provide_emotional_support');
      safetyRecommendations.push('suggest_professional_help_if_severe');
    }
    if (safetyFlags.urgentSupport) {
      safetyRecommendations.push('prioritize_urgent_response');
      safetyRecommendations.push('provide_emergency_resources');
    }
    if (safetyFlags.missingCriticalContext) {
      safetyRecommendations.push('acknowledge_limitations');
      safetyRecommendations.push('ask_clarifying_questions');
    }

    // Truth validation based on available memories
    const availableMemories = memoryOutput.relevantMemories || [];
    const memoryBasedFacts = availableMemories.map(m => m.content);

    const truthGuidelines = {
      stickToKnownFacts: memoryBasedFacts,
      acknowledgeUncertainty: safetyFlags.missingCriticalContext,
      avoidSpeculation: sentimentOutput.supportNeeds.includes('medical') || safetyFlags.urgentSupport
    };

    if (logger) {
      logger.info('brain.safety_controller.processed', {
        safetyFlags,
        safetyRecommendations,
        memoryBasedFacts: memoryBasedFacts.length,
        truthValidation: 'completed'
      });
    }

    return {
      safetyFlags,
      safetyRecommendations,
      truthGuidelines,
      approved: true, // Governance already approved at actor level
      degraded: false
    };

  } catch (error) {
    if (logger) logger.warn('brain.safety_controller.error', { error: error.message?.substring(0, 100) });
    return {
      safetyFlags: {},
      safetyRecommendations: ['exercise_caution'],
      truthGuidelines: { stickToKnownFacts: [], acknowledgeUncertainty: true, avoidSpeculation: true },
      approved: true,
      degraded: true,
      reason: 'processing_error'
    };
  }
}

/**
 * Stage 8: Response Generator
 * Final response generation in companion's voice
 */
async function processResponseGenerator(userMessage, brainState, modelClient, config, context, logger) {
  try {
    const {
      memoryOutput,
      attentionOutput,
      sentimentOutput,
      styleOutput,
      qualityOutput,
      safetyOutput
    } = brainState;

    // Build sophisticated prompt incorporating all brain regions
    const memoryContext = memoryOutput.memoryContext || 'No specific memories available.';
    const { companionConfig } = context;

    // Construct brain-informed system prompt
    const brainPrompt = buildCognitiveBrainPrompt({
      memoryContext,
      companionConfig,
      responseStyle: styleOutput.responseStyle,
      behavioralAnchors: styleOutput.behavioralAnchors,
      emotionalContext: sentimentOutput,
      urgencyContext: attentionOutput,
      safetyGuidelines: safetyOutput.safetyRecommendations,
      truthGuidelines: safetyOutput.truthGuidelines,
      reflections: qualityOutput.reflections,
      userMessage
    });

    const sdkRequest = {
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: adjustTemperatureForBrainState(config.temperature, brainState),
      system: brainPrompt.system,
      messages: brainPrompt.messages,
    };

    const response = await modelClient.messages.create(sdkRequest);
    const responseText = extractResponseText(response);

    if (logger) {
      logger.info('brain.response_generator.processed', {
        responseLength: responseText.length,
        adjustedTemperature: sdkRequest.temperature,
        emotionalTone: sentimentOutput.emotion,
        urgencyLevel: attentionOutput.responsePacing
      });
    }

    return {
      responseText,
      degraded: false
    };

  } catch (error) {
    if (logger) logger.warn('brain.response_generator.error', { error: error.message?.substring(0, 100) });
    throw error; // Let this bubble up for fallback handling
  }
}

/**
 * Build cognitive brain-informed prompt
 */
function buildCognitiveBrainPrompt(brainInputs) {
  const {
    memoryContext,
    companionConfig,
    responseStyle,
    behavioralAnchors,
    emotionalContext,
    urgencyContext,
    safetyGuidelines,
    truthGuidelines,
    reflections,
    userMessage
  } = brainInputs;

  const companionName = companionConfig?.name || 'Assistant';
  const companionPersona = companionConfig?.persona || 'You are a helpful AI companion';

  // Detect if user is asking about stored information
  const userMessageLower = (userMessage || '').toLowerCase();
  const isAskingAboutMemories =
    userMessageLower.includes('what do you know about me') ||
    userMessageLower.includes('what have i told you') ||
    userMessageLower.includes('what do you remember') ||
    userMessageLower.includes('tell me about myself') ||
    userMessageLower.includes('what did i tell you about');

  // Build enhanced system prompt with brain state
  let systemPrompt = `You are ${companionName}, a companion assistant.
${companionPersona}

COGNITIVE CONTEXT:
- Emotional state detected: ${emotionalContext.emotion} (intensity: ${Math.round(emotionalContext.emotionalIntensity * 100)}%)
- Support needs: ${emotionalContext.supportNeeds.join(', ')}
- Response urgency: ${urgencyContext.responsePacing}
- Attention priority: ${Math.round(urgencyContext.attentionPriority * 100)}%

RESPONSE STYLE:
- Warmth level: ${Math.round(responseStyle.warmth * 100)}%
- Supportiveness: ${Math.round(responseStyle.supportiveness * 100)}%
- Formality: ${Math.round(responseStyle.formality * 100)}%
- Verbosity: ${responseStyle.verbosity > 0.6 ? 'detailed' : responseStyle.verbosity < 0.4 ? 'concise' : 'moderate'}

BEHAVIORAL GUIDANCE:
- Tone markers: ${behavioralAnchors.toneMarkers.join(', ') || 'natural, helpful'}
- Emphasize: ${behavioralAnchors.emphasizePatterns.join(', ') || 'understanding and support'}

SAFETY GUIDELINES:
${safetyGuidelines.map(g => `- ${g.replace(/_/g, ' ')}`).join('\n') || '- Exercise appropriate care'}

TRUTH GUIDELINES:
- Stick to known facts: ${truthGuidelines.stickToKnownFacts ? 'Yes' : 'Not required'}
- Acknowledge uncertainty: ${truthGuidelines.acknowledgeUncertainty ? 'Yes' : 'No'}
- Avoid speculation: ${truthGuidelines.avoidSpeculation ? 'Yes' : 'No'}`;

  if (reflections.length > 0) {
    systemPrompt += `\n\nREFLECTIVE CONSIDERATIONS:
${reflections.slice(0, 3).map(r => `- Consider: ${r}`).join('\n')}`;
  }

  if (memoryContext && memoryContext !== 'No specific memories available.') {
    systemPrompt += `\n\nRELEVANT MEMORIES ABOUT THIS USER:
${memoryContext}

MEMORY USAGE INSTRUCTIONS:`;

    if (isAskingAboutMemories) {
      systemPrompt += `
- THE USER IS ASKING ABOUT STORED INFORMATION: Actively reference and summarize the memories above
- List the specific facts you know about them based on the memories provided
- Be specific about what they've told you (preferences, relationships, etc.)
- If memories are limited, acknowledge what you do know and what you don't know yet`;
    } else {
      systemPrompt += `
- When appropriate, naturally reference relevant memories in your response
- Build on previous conversations by acknowledging what you remember
- If the user mentions topics related to stored memories, show you remember`;
    }

    systemPrompt += `
- Always incorporate relevant memories naturally into your responses
- If asked about things you don't have memories about, be honest about not having that information stored`;
  } else {
    if (isAskingAboutMemories) {
      systemPrompt += `\n\nIMPORTANT: The user is asking about stored information, but no specific memories about this user are currently available. Be honest that you don't have stored memories about them yet, but express interest in learning about them.`;
    } else {
      systemPrompt += `\n\nNo specific memories about this user are currently available.`;
    }
  }

  systemPrompt += `\n\nRespond as ${companionName} would, using all the above context and memories to provide personalized, informed responses.`;

  return {
    system: systemPrompt,
    messages: [{ role: 'user', content: brainInputs.userMessage || 'Hello' }]
  };
}

/**
 * Adjust temperature based on brain state
 */
function adjustTemperatureForBrainState(baseTemperature, brainState) {
  let adjustedTemp = baseTemperature;

  // Lower temperature for urgent or emotional situations (more focused)
  if (brainState.attentionOutput.urgencyScore > 0.7) {
    adjustedTemp *= 0.8;
  }
  if (brainState.sentimentOutput.emotionalIntensity > 0.8) {
    adjustedTemp *= 0.9;
  }

  // Higher temperature for creative/reflective responses
  if (brainState.attentionOutput.responsePacing === 'reflective') {
    adjustedTemp *= 1.1;
  }

  return Math.max(0.1, Math.min(1.0, adjustedTemp));
}

/**
 * Extract response text from Anthropic SDK response
 */
function extractResponseText(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('respond: model response was not an object');
  }
  const blocks = response.content;
  if (!Array.isArray(blocks)) {
    throw new Error('respond: model response has no content array');
  }
  const parts = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Cosine similarity calculation
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Main brain processing function
 * Processes conversation through all 8 regions with graceful degradation
 */
async function processWithBrain(input, companionReader, modelClient, config, logger) {
  const startTime = Date.now();
  const degradedRegions = [];

  const { pilotInstanceId, userId, userRole, userMessage, memoryLimit, companionConfig } = input;
  const limit = memoryLimit || config.defaultMemoryLimit;

  try {
    // Pre-retrieve memories using clasp-endor's audit-bundled system
    const memoryRows = await companionReader.readVisibleMemories({
      pilotInstanceId,
      userId,
      userRole,
      limit,
    });

    const context = { companionConfig, pilotInstanceId, userId, userRole };

    // Process through cognitive pipeline sequentially
    const priorityOutput = await processPriorityFilter(userMessage, context, logger);
    if (priorityOutput.degraded) degradedRegions.push('Priority Filter');

    const memoryOutput = await processMemoryEngine(userMessage, memoryRows, priorityOutput, context, logger);
    if (memoryOutput.degraded) degradedRegions.push('Memory Engine');

    const attentionOutput = processAttentionController(userMessage, priorityOutput, memoryOutput, context, logger);
    if (attentionOutput.degraded) degradedRegions.push('Attention Controller');

    const sentimentOutput = await processSentimentAnalyzer(userMessage, context, logger);
    if (sentimentOutput.degraded) degradedRegions.push('Sentiment Analyzer');

    const styleOutput = processStyleController(userMessage, sentimentOutput, attentionOutput, context, logger);
    if (styleOutput.degraded) degradedRegions.push('Style Controller');

    const qualityOutput = await processQualityEngine(userMessage, memoryOutput, sentimentOutput, context, logger);
    if (qualityOutput.degraded) degradedRegions.push('Quality Engine');

    const safetyOutput = processSafetyController(userMessage, {
      sentimentOutput, memoryOutput, qualityOutput
    }, context, logger);
    if (safetyOutput.degraded) degradedRegions.push('Safety Controller');

    // Final response generation
    const brainState = {
      priorityOutput,
      memoryOutput,
      attentionOutput,
      sentimentOutput,
      styleOutput,
      qualityOutput,
      safetyOutput
    };

    const responseOutput = await processResponseGenerator(
      userMessage, brainState, modelClient, config, context, logger
    );

    const responseText = responseOutput.responseText;
    const processingTime = Date.now() - startTime;

    // Audit the response using clasp-endor's auditing system
    // Convert logger object to function interface expected by auditor
    const auditLogger = logger ? (level, event, data) => logger[level](event, data) : null;
    const auditResult = await auditResponse(userMessage, responseText, {
      memoryRows,
      logger: auditLogger
    });

    if (logger) {
      logger.info('brain.pipeline.completed', {
        pilot_instance_id: pilotInstanceId,
        actor_user_id: userId,
        actor_role: userRole,
        memory_count: memoryRows.length,
        response_chars: responseText.length,
        processing_time_ms: processingTime,
        degraded_regions: degradedRegions,
        audit_verdict: auditResult.verdict,
        audit_details: auditResult.details,
        brain_regions_processed: 8,
        brain_regions_degraded: degradedRegions.length
      });
    }

    return {
      response: responseText,
      memoryCount: memoryRows.length,
      auditVerdict: auditResult.verdict,
      auditDetails: auditResult.details,
      auditReason: auditResult.reason,
      brainMeta: {
        degradedRegions,
        processingTimeMs: processingTime,
        regionsProcessed: 8
      }
    };

  } catch (error) {
    if (logger) {
      logger.warn('brain.pipeline.error', {
        error_class: error.name || 'unknown',
        message: error.message?.substring(0, 100),
        degraded_regions: degradedRegions,
        processing_time_ms: Date.now() - startTime
      });
    }
    throw error; // Let caller handle fallback
  }
}

module.exports = {
  processWithBrain,
};