#!/usr/bin/env node
'use strict';

const dns = require('dns');
const { promisify } = require('util');

const lookupAsync = promisify(dns.lookup);

async function debugNetwork() {
  const host = 'aws-1-us-west-2.pooler.supabase.com';

  console.log(`🔍 Network diagnostics for ${host}`);
  console.log('Environment:', process.env.NODE_ENV || 'unknown');

  try {
    console.log('\n📡 DNS lookup...');
    const result = await lookupAsync(host);
    console.log('✅ DNS resolved:', result);

    // Try to test connectivity
    const net = require('net');
    console.log('\n🔌 Testing port 5432...');

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, 5000);

      socket.connect(5432, host, () => {
        clearTimeout(timeout);
        console.log('✅ Port 5432 reachable');
        socket.destroy();
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

  } catch (error) {
    console.log('❌ Network error:', error.message);
    console.log('Error code:', error.code);
    process.exit(1);
  }
}

debugNetwork().then(() => {
  console.log('✅ Network diagnostics passed');
}).catch((err) => {
  console.log('❌ Network diagnostics failed:', err.message);
  process.exit(1);
});