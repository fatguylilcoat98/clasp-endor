const { createBrainEnabledRuntime } = require('./src/conversation/brain-runtime');

// Mock components for testing
function createMockModelClient() {
  return {
    messages: {
      create: async (request) => {
        // Show the enhanced prompt that Barry would receive
        console.log('🧠 ENHANCED PROMPT SENT TO BARRY:');
        console.log('=====================================');
        console.log(request.system);
        console.log('=====================================\n');

        return {
          content: [{ type: 'text', text: 'I understand and will use the memories provided!' }]
        };
      }
    }
  };
}

function createMockCompanionReader(memoryRows = []) {
  return {
    readVisibleMemories: async () => memoryRows
  };
}

async function testEnhancedMemoryPrompting() {
  console.log('🔧 TESTING ENHANCED MEMORY PROMPTING FIX\n');

  const mockMemories = [
    {
      id: 'mem-test-1',
      content: 'User likes pineapple on pizza',
      provenance: 'USER_STATED',
      memory_status: 'WORKING_ACTIVE'
    },
    {
      id: 'mem-test-2',
      content: "User's brother is named Daniel",
      provenance: 'USER_STATED',
      memory_status: 'WORKING_ACTIVE'
    }
  ];

  const runtime = createBrainEnabledRuntime({
    companionReader: createMockCompanionReader(mockMemories),
    modelClient: createMockModelClient(),
    log: {
      info: () => {}, // Silent for this test
      warn: () => {},
      error: () => {}
    },
    config: {
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
      temperature: 0.3
    }
  });

  console.log('📝 Testing question: "What do you know about me so far?"\n');

  try {
    await runtime.respond({
      pilotInstanceId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      userRole: 'senior',
      userMessage: 'What do you know about me so far?',
      companionConfig: { name: 'Barry' }
    });

    console.log('✅ Enhanced memory prompting test completed successfully!');

  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
  }
}

testEnhancedMemoryPrompting().catch(console.error);