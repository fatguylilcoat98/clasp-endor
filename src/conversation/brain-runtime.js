'use strict';
/*
 * Brain-enabled conversation runtime for clasp-endor
 *
 * Wraps the Splendor brain architecture with clasp-endor's conversation
 * runtime, preserving all governance boundaries and fallback capabilities.
 *
 * Falls back to standard runtime if brain processing fails, ensuring
 * chat never hard-fails due to brain pipeline issues.
 */

const { createConversationRuntime } = require('./runtime');
const { processWithBrain } = require('./brain');

function createBrainEnabledRuntime(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createBrainEnabledRuntime: options object is required');
  }

  const { companionReader, modelClient, log } = options;
  const cfg = options.config || {};
  const logger = log && typeof log.info === 'function' ? log : null;

  // Convert logger object to runtime-compatible format for standard runtime
  const runtimeLoggerFn = logger ? (level, event, data) => {
    if (logger[level]) {
      logger[level](event, data);
    } else {
      logger.info(event, data);
    }
  } : null;

  // Create the fallback standard runtime with proper config
  const standardRuntime = createConversationRuntime({
    companionReader,
    modelClient,
    log: runtimeLoggerFn,
    config: cfg
  });

  // Brain-enabled response function
  async function respond(input) {
    const isBrainEnabled = process.env.BRAIN_ENABLED !== 'false';

    // If brain is disabled, use standard runtime
    if (!isBrainEnabled) {
      if (logger) {
        logger.info('brain.disabled', { reason: 'BRAIN_ENABLED=false' });
      }
      return await standardRuntime.respond(input);
    }

    // Attempt brain processing with fallback
    try {
      if (logger) {
        logger.info('brain.attempting', {
          pilot_instance_id: input.pilotInstanceId,
          user_id: input.userId,
          message_length: input.userMessage ? input.userMessage.length : 0
        });
      }

      // Process through brain pipeline
      const brainResult = await processWithBrain(
        input,
        companionReader,
        modelClient,
        {
          model: cfg.model || 'claude-sonnet-4-6',
          maxTokens: cfg.maxTokens || 1024,
          temperature: cfg.temperature || 0.3,
          defaultMemoryLimit: cfg.defaultMemoryLimit || 20
        },
        logger
      );

      if (logger) {
        logger.info('brain.success', {
          pilot_instance_id: input.pilotInstanceId,
          degraded_regions: brainResult.brainMeta.degradedRegions,
          processing_time_ms: brainResult.brainMeta.processingTimeMs
        });
      }

      return brainResult;

    } catch (brainError) {
      // Log brain failure and fall back to standard runtime
      if (logger) {
        logger.warn('brain.fallback_triggered', {
          pilot_instance_id: input.pilotInstanceId,
          brain_error_class: brainError.name || 'unknown',
          brain_error_message: brainError.message?.substring(0, 100),
          fallback_to: 'standard_runtime'
        });
      }

      try {
        // Fall back to standard conversation runtime
        const fallbackResult = await standardRuntime.respond(input);

        if (logger) {
          logger.info('brain.fallback_success', {
            pilot_instance_id: input.pilotInstanceId,
            fallback_response_chars: fallbackResult.response ? fallbackResult.response.length : 0
          });
        }

        // Add brain metadata to indicate fallback
        return {
          ...fallbackResult,
          brainMeta: {
            degradedRegions: ['ALL'],
            processingTimeMs: 0,
            regionsProcessed: 0,
            fallbackUsed: true,
            fallbackReason: brainError.message?.substring(0, 100)
          }
        };

      } catch (fallbackError) {
        // Both brain and fallback failed
        if (logger) {
          logger.error('brain.total_failure', {
            pilot_instance_id: input.pilotInstanceId,
            brain_error: brainError.message?.substring(0, 100),
            fallback_error: fallbackError.message?.substring(0, 100)
          });
        }

        // Re-throw the fallback error since it's the more fundamental failure
        throw fallbackError;
      }
    }
  }

  return Object.freeze({ respond });
}

module.exports = {
  createBrainEnabledRuntime,
};
