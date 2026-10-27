const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
const schemaPath = path.resolve(__dirname, '..', 'database_schema.sql');

(async () => {
  try {
    await pool.query(fs.readFileSync(schemaPath, 'utf8'));
    console.log('ALIVIO database schema applied.');
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
