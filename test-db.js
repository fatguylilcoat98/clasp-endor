#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Paste your Supabase pooler connection string here:
const CONNECTION_STRING = process.env.TEST_DB_URL || 'postgresql://postgres.lyeyfbzaeuhyxlydmnlg:2dIE9NSXxDOAYTvg@aws-1-us-west-2.pooler.supabase.com:5432/postgres';

// Load SSL config (same as the real clients)
function getSSLConfig() {
  const caCertPath = path.join(__dirname, 'certs', 'supabase-ca.crt');
  try {
    const ca = fs.readFileSync(caCertPath, 'utf8');
    return {
      rejectUnauthorized: true,
      ca: ca,
    };
  } catch (err) {
    console.log('❌ Failed to load SSL certificate:', err.message);
    return undefined;
  }
}

async function testConnection() {
  console.log('🔍 Testing Supabase database connection...');
  console.log('Connection string host:', CONNECTION_STRING.split('@')[1]?.split('/')[0] || 'unknown');

  const sslConfig = getSSLConfig();
  if (sslConfig) {
    console.log('✅ SSL certificate loaded');
  } else {
    console.log('⚠️ No SSL certificate - will try without');
  }

  const client = new Client({
    connectionString: CONNECTION_STRING,
    ssl: sslConfig,
  });

  try {
    console.log('\n📡 Attempting connection...');
    await client.connect();
    console.log('✅ Connected successfully!');

    console.log('\n🔄 Running test query...');
    const result = await client.query('SELECT 1 as test, current_user, current_database()');
    console.log('✅ Query successful:', result.rows[0]);

    await client.end();
    console.log('✅ Connection closed cleanly');

  } catch (error) {
    console.log('\n❌ CONNECTION FAILED - FULL ERROR DETAILS:');
    console.log('=====================================');

    // Print EVERYTHING about the error
    console.log('Error object:', error);
    console.log('\nError properties:');
    for (const [key, value] of Object.entries(error)) {
      console.log(`  ${key}:`, value);
    }

    // PostgreSQL-specific error fields
    if (error.severity) console.log('PostgreSQL severity:', error.severity);
    if (error.code) console.log('PostgreSQL error code:', error.code);
    if (error.detail) console.log('PostgreSQL detail:', error.detail);
    if (error.hint) console.log('PostgreSQL hint:', error.hint);
    if (error.position) console.log('PostgreSQL position:', error.position);
    if (error.internalPosition) console.log('PostgreSQL internal position:', error.internalPosition);
    if (error.internalQuery) console.log('PostgreSQL internal query:', error.internalQuery);
    if (error.where) console.log('PostgreSQL where:', error.where);
    if (error.schema) console.log('PostgreSQL schema:', error.schema);
    if (error.table) console.log('PostgreSQL table:', error.table);
    if (error.column) console.log('PostgreSQL column:', error.column);
    if (error.dataType) console.log('PostgreSQL data type:', error.dataType);
    if (error.constraint) console.log('PostgreSQL constraint:', error.constraint);
    if (error.file) console.log('PostgreSQL file:', error.file);
    if (error.line) console.log('PostgreSQL line:', error.line);
    if (error.routine) console.log('PostgreSQL routine:', error.routine);

    // Try to close client if still connected
    try {
      await client.end();
    } catch (closeError) {
      console.log('Failed to close client:', closeError.message);
    }

    process.exit(1);
  }
}

// Run the test
testConnection().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});