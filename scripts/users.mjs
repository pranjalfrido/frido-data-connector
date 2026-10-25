#!/usr/bin/env node
// Usage:
//   node scripts/users.mjs add <email> <full_name> <role> <approved_by>
//   node scripts/users.mjs deactivate <email>
//   node scripts/users.mjs activate <email>
//   node scripts/users.mjs set-role <email> <role>
//   node scripts/users.mjs list

import pg from 'pg';
import { readFileSync } from 'fs';

const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('Set SUPABASE_DB_URL env var'); process.exit(1); }

// Supabase pooler (port 5432) uses a self-signed cert; direct (port 5433) uses trusted CA
const sslMode = url.includes(':5432') ? { rejectUnauthorized: false } : true;
const pool = new pg.Pool({ connectionString: url, ssl: sslMode });

const VALID_ROLES = ['founder', 'finance', 'ops', 'marketing', 'analyst'];
const [,, cmd, ...args] = process.argv;

async function run() {
  switch (cmd) {
    case 'add': {
      const [email, full_name, role, approved_by] = args;
      if (!email || !full_name || !role) { console.error('Usage: add <email> <full_name> <role> [approved_by]'); process.exit(1); }
      if (!VALID_ROLES.includes(role)) { console.error(`Role must be one of: ${VALID_ROLES.join(', ')}`); process.exit(1); }
      await pool.query(
        `INSERT INTO connector_users (email, full_name, role, approved_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET full_name=$2, role=$3, is_active=true, approved_by=$4, deactivated_at=NULL`,
        [email.toLowerCase(), full_name, role, approved_by || 'admin']
      );
      console.log(`✓ User ${email} added with role ${role}`);
      break;
    }
    case 'deactivate': {
      const [email] = args;
      await pool.query(
        `UPDATE connector_users SET is_active=false, deactivated_at=now() WHERE email=$1`,
        [email.toLowerCase()]
      );
      console.log(`✓ User ${email} deactivated`);
      break;
    }
    case 'activate': {
      const [email] = args;
      await pool.query(
        `UPDATE connector_users SET is_active=true, deactivated_at=NULL WHERE email=$1`,
        [email.toLowerCase()]
      );
      console.log(`✓ User ${email} activated`);
      break;
    }
    case 'set-role': {
      const [email, role] = args;
      if (!VALID_ROLES.includes(role)) { console.error(`Role must be one of: ${VALID_ROLES.join(', ')}`); process.exit(1); }
      await pool.query(`UPDATE connector_users SET role=$2 WHERE email=$1`, [email.toLowerCase(), role]);
      console.log(`✓ User ${email} role set to ${role}`);
      break;
    }
    case 'list': {
      const { rows } = await pool.query(
        `SELECT email, full_name, role, is_active, approved_by, created_at FROM connector_users ORDER BY created_at`
      );
      console.table(rows);
      break;
    }
    default:
      console.error('Commands: add | deactivate | activate | set-role | list');
      process.exit(1);
  }
  await pool.end();
}

run().catch(err => { console.error(err.message); process.exit(1); });
