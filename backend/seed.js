const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before seeding.');
const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || '');
const name = String(process.env.ADMIN_NAME || 'ALIVIO Administrator').trim();
if (!email || password.length < 12) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) to create the initial administrator.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });

(async () => {
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'ADMIN')
       ON CONFLICT (email) DO NOTHING`,
      [name, email, hash]
    );
    console.log(`Administrator account ensured for ${email}. Existing accounts are not overwritten.`);
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error('Admin seed failed:', error.message);
  process.exitCode = 1;
});
