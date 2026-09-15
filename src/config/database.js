'use strict';

const fs = require('fs');
const { Pool } = require('pg');

function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined
  });
}

function createInitDb({ pool, databaseUrl, schemaFile }) {
  return async function initDb() {
    if (!databaseUrl) throw new Error('DATABASE_URL is missing in .env');
    await pool.query(fs.readFileSync(schemaFile, 'utf8'));
  };
}

module.exports = { createPool, createInitDb };
