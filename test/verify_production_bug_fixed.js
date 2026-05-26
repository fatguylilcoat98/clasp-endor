'use strict';
/*
 * Verify the exact production bug is fixed: "facts.filter is not a function"
 *
 * This test focuses on ensuring no TypeError occurs when the AI layer
 * returns non-array values, regardless of final fact counts.
 */

const { createMemoryWriter } = require('../src/memory/writer');

// Mock memory pool
function createMockMemoryPool() {
  return {
    connect: () => ({
      query: async (sql, params) => ({
        rows: [{
          id: `mem-${Date.now()}`,
          created_at: new Date(),
          content: params && params[2] ? params[2] : 'test'
        }]
      }),
      release: () => {}
    })
  };
}

// Mock the AI extraction to return problematic responses
function mockAIExtractionWithResponse(responseValue) {
  const originalModule = require('../src/memory/extractor');

  // Create a version that directly returns the problematic value
  const mockExtractMemoriableFacts = async function(userMessage, options = {}) {
    const { logger } = options;

    if (logger) {
      logger.info('memory.extraction.mock_test', {
        returning_value: typeof responseValue,
        is_array: Array.isArray(responseValue)
      });
    }

    // This is what would cause "facts.filter is not a function"
    // if the guards aren't working
    return responseValue;
  };

  return { ...originalModule, extractMemoriableFacts: mockExtractMemoriableFacts };
}

async function testProductionBugScenario(testName, mockResponseValue) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔬 TEST: ${testName}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Mock extraction returns: ${typeof mockResponseValue} (${Array.isArray(mockResponseValue) ? 'array' : 'not array'})`);
  console.log(`Value: ${JSON.stringify(mockResponseValue)}`);

  const logs = [];
  const logger = {
    info: (event, data) => {
      const log = `[INFO] ${event}: ${JSON.stringify(data)}`;
      logs.push(log);
      console.log(`  ${log}`);
    },
    warn: (event, data) => {
      const log = `[WARN] ${event}: ${JSON.stringify(data)}`;
      logs.push(log);
      console.log(`  ${log}`);
    }
  };

  try {
    // Mock the extraction to return the problematic value
    const mockExtractor = mockAIExtractionWithResponse(mockResponseValue);

    // Create writer with mocked extractor
    const originalExtractMemoriableFacts = require('../src/memory/extractor').extractMemoriableFacts;
    require('../src/memory/extractor').extractMemoriableFacts = mockExtractor.extractMemoriableFacts;

    const mockPool = createMockMemoryPool();
    const writer = createMemoryWriter({
      memoryPool: mockPool,
      logger
    });

    // This is where "facts.filter is not a function" would occur
    const result = await writer.storeWorkingMemories({
      userMessage: 'Remember this test',
      pilotInstanceId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      userRole: 'senior'
    });

    // Restore original function
    require('../src/memory/extractor').extractMemoriableFacts = originalExtractMemoriableFacts;

    console.log(`  ✅ SUCCESS: No TypeError occurred!`);
    console.log(`  Result: ${JSON.stringify(result)}`);
    return { passed: true, result };

  } catch (error) {
    console.log(`  ❌ FAILED: ${error.name}: ${error.message}`);

    if (error.message.includes('filter is not a function')) {
      console.log(`  🚨 CRITICAL: This is the exact production bug!`);
      return { passed: false, isCriticalBug: true, error: error.message };
    } else {
      console.log(`  ⚠️  Different error (may be acceptable): ${error.message}`);
      return { passed: false, isCriticalBug: false, error: error.message };
    }
  }
}

async function runProductionBugVerification() {
  console.log('🚨 PRODUCTION BUG VERIFICATION TEST');
  console.log('===================================');
  console.log('Testing scenarios that caused "facts.filter is not a function" in production\n');

  // Test cases that could cause the production bug
  const testCases = [
    {
      name: 'AI returns object {facts: [...]}',
      value: { facts: [{ fact: 'test fact', confidence: 0.8 }] }
    },
    {
      name: 'AI returns string',
      value: 'this is just a string'
    },
    {
      name: 'AI returns null',
      value: null
    },
    {
      name: 'AI returns undefined',
      value: undefined
    },
    {
      name: 'AI returns number',
      value: 42
    },
    {
      name: 'AI returns empty object',
      value: {}
    },
    {
      name: 'AI returns boolean',
      value: true
    }
  ];

  const results = [];

  for (const testCase of testCases) {
    const result = await testProductionBugScenario(testCase.name, testCase.value);
    results.push({ name: testCase.name, ...result });
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('🎯 PRODUCTION BUG VERIFICATION SUMMARY');
  console.log(`${'='.repeat(60)}`);

  let criticalBugsFound = 0;
  let passedTests = 0;

  results.forEach((result, i) => {
    const status = result.passed ? '✅' : '❌';
    console.log(`${i+1}. ${status} ${result.name}`);

    if (result.passed) {
      passedTests++;
    } else if (result.isCriticalBug) {
      criticalBugsFound++;
      console.log(`   🚨 CRITICAL BUG: ${result.error}`);
    } else {
      console.log(`   ⚠️  Non-critical error: ${result.error}`);
    }
  });

  const allPassed = passedTests === results.length;
  console.log(`\nResults: ${passedTests}/${results.length} tests passed`);
  console.log(`Critical bugs found: ${criticalBugsFound}`);

  if (allPassed) {
    console.log('\n🎉 PRODUCTION BUG FIXED!');
    console.log('✅ No "facts.filter is not a function" errors occurred');
    console.log('✅ Array guards are working correctly');
    console.log('✅ System handles all AI layer failure modes gracefully');
  } else if (criticalBugsFound > 0) {
    console.log('\n🚨 PRODUCTION BUG STILL EXISTS!');
    console.log('❌ "facts.filter is not a function" still occurring');
  } else {
    console.log('\n⚠️  MIXED RESULTS');
    console.log('✅ No critical "facts.filter" bugs');
    console.log('⚠️  Some other errors occurred (may be acceptable)');
  }

  return { allPassed, criticalBugsFound, passedTests, totalTests: results.length };
}

if (require.main === module) {
  runProductionBugVerification().catch(console.error);
}

module.exports = { runProductionBugVerification };