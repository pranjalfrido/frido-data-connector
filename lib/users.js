import pg from 'pg';

let _pool;
function getPool() {
  if (_pool) return _pool;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('Missing SUPABASE_DB_URL env var');
  _pool = new pg.Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: false }, // Supabase pooler uses self-signed cert
  });
  return _pool;
}

// 60-second in-memory cache: email → { profile, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = 60_000;

export async function getUserProfile(email) {
  const cached = cache.get(email);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.profile;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT email, full_name, role, is_active FROM connector_users WHERE email = $1 LIMIT 1`,
    [email]
  );

  const profile = rows[0] || null;
  cache.set(email, { profile, fetchedAt: Date.now() });
  return profile;
}

export function invalidateCache(email) {
  cache.delete(email);
}
