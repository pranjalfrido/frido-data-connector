import crypto from 'crypto';
import pg from 'pg';
import { sendAlertEmail } from './mailer.js';

let _pool;
function getPool() {
  if (_pool) return _pool;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('Missing SUPABASE_DB_URL');
  _pool = new pg.Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}

// In-memory counters for alert triggers (resets on container restart — good enough for Cloud Run)
const denialWindow = new Map();   // email → [timestamps]
const callWindow = new Map();     // email → [timestamps]

function hashCommand(cmd) {
  return crypto.createHash('sha256').update(cmd).digest('hex').slice(0, 16);
}

function extractTables(command) {
  const matches = command.match(/(?:FROM|JOIN|UPDATE|INTO)\s+[`"]?([a-zA-Z0-9_.]+)[`"]?/gi) || [];
  return [...new Set(matches.map(m => m.replace(/^(FROM|JOIN|UPDATE|INTO)\s+/i, '').replace(/[`"]/g, '')))];
}

function windowCount(map, key, windowMs) {
  const now = Date.now();
  const times = (map.get(key) || []).filter(t => now - t < windowMs);
  times.push(now);
  map.set(key, times);
  return times.length;
}

export async function writeAuditLog(entry) {
  const {
    user, tool, target, command, outcome,
    denialReason, rowsReturned, bytesProcessed, latencyMs, reqId,
  } = entry;

  const tables = command ? extractTables(command) : [];
  const commandHash = command ? hashCommand(command) : null;

  // Fire-and-forget — never block the response
  setImmediate(async () => {
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO connector_audit_log
           (user_email, user_role, tool, target, command_hash, tables_accessed,
            outcome, denial_reason, rows_returned, bytes_processed, latency_ms, req_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          user.email, user.role, tool, target, commandHash, tables,
          outcome, denialReason || null,
          rowsReturned || null, bytesProcessed || null,
          latencyMs || null, reqId || null,
        ]
      );
    } catch (err) {
      console.error(`[audit] DB write failed: ${err.message}`);
    }

    // Alert checks
    await checkAlerts(entry, tables);
  });
}

async function checkAlerts(entry, tables) {
  const { user, outcome, denialReason, command, target } = entry;

  // Alert 1: 5+ denials from same user in 10 minutes
  if (outcome === 'denied') {
    const count = windowCount(denialWindow, user.email, 10 * 60 * 1000);
    if (count === 5) {
      await sendAlertEmail(
        `Repeated access denials — ${user.email}`,
        [
          `<strong>User:</strong> ${user.email} (role: ${user.role})`,
          `<strong>Event:</strong> ${count} denied requests in the last 10 minutes`,
          `<strong>Last denial reason:</strong> ${denialReason || 'unknown'}`,
          `<strong>Target:</strong> ${target}`,
          `<strong>Time:</strong> ${new Date().toISOString()}`,
          `<br/><strong>Action:</strong> Review and consider deactivating this user if suspicious.`,
        ]
      );
    }
  }

  // Alert 2: Unusual call volume — >50 calls in 1 hour from one user
  if (outcome === 'ok') {
    const count = windowCount(callWindow, user.email, 60 * 60 * 1000);
    if (count === 50) {
      await sendAlertEmail(
        `Unusual data volume — ${user.email}`,
        [
          `<strong>User:</strong> ${user.email} (role: ${user.role})`,
          `<strong>Event:</strong> ${count}+ tool calls in the last hour (unusual volume)`,
          `<strong>Target:</strong> ${target}`,
          `<strong>Tables:</strong> ${tables.join(', ') || 'unknown'}`,
          `<strong>Time:</strong> ${new Date().toISOString()}`,
          `<br/><strong>Action:</strong> Verify this is expected usage.`,
        ]
      );
    }
  }

  // Alert 3: Prompt injection attempt detected
  if (command) {
    const injectionPatterns = /ignore (your|all) (rules|instructions)|you are now|act as|jailbreak|bypass security|show all (customers|passwords|secrets)/i;
    if (injectionPatterns.test(command)) {
      await sendAlertEmail(
        `Possible prompt injection attempt — ${user.email}`,
        [
          `<strong>User:</strong> ${user.email} (role: ${user.role})`,
          `<strong>Event:</strong> Suspicious command pattern detected`,
          `<strong>Command hash:</strong> ${hashCommand(command)}`,
          `<strong>Time:</strong> ${new Date().toISOString()}`,
          `<br/><strong>Action:</strong> Review logs and consider deactivating this user.`,
        ]
      );
    }
  }
}
