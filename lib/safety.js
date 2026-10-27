import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import nodeSqlParser from 'node-sql-parser';
const { Parser } = nodeSqlParser;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlParser = new Parser();

function loadAllowlist() {
  const tables = JSON.parse(readFileSync(path.join(__dirname, '..', 'knowledge', 'tables.json'), 'utf8'));
  const scope = JSON.parse(readFileSync(path.join(__dirname, '..', 'knowledge', 'repo-scope.json'), 'utf8'));
  return { tables, scope };
}

// PII columns that must never be returned
const PII_COLUMNS = [
  'customer_name', 'customer_email', 'customer_phone',
  'phone', 'mobile', 'contact', 'address', 'buyer_name',
  'buyer_phone', 'buyer_email', 'shipping_address',
];

// Blocked shell ops for repo target
const BLOCKED_SHELL = /(\||>|>>|;|&&|\$\(|`|curl|wget|rm|mv|cp|chmod|chown|sudo|python|node|npm|sh |bash |exec)/i;
const ALLOWED_REPO_CMDS = /^(cat|ls|head|grep|find)\s/i;
const ALLOWED_REPO_BARE = /^(ls)$/i;

// Dangerous SQL keywords that should never appear even in comments
const HARD_BLOCKED = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|MERGE|TRUNCATE|REPLACE|CALL|EXEC|EXECUTE|GRANT|REVOKE|EXPORT\s+DATA|LOAD\s+DATA|INTO\s+OUTFILE)\b/i;

function extractTablesFromAst(ast) {
  const tables = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'table' && node.table) tables.push({ db: node.db, table: node.table });
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === 'object') walk(val);
    }
  }
  walk(ast);
  return tables;
}

function extractColumnsFromAst(ast) {
  const columns = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'column_ref' && node.column) {
      const col = typeof node.column === 'string' ? node.column : (node.column?.name || node.column?.value || String(node.column));
      columns.push(col.toLowerCase());
    }
    if (node.type === 'select' && node.columns === '*') columns.push('*');
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === 'object') walk(val);
    }
  }
  walk(ast);
  return columns;
}

function checkSql(cmd, target) {
  // Hard block — catches DML/DDL even hidden in comments
  if (HARD_BLOCKED.test(cmd)) {
    return { ok: false, reason: 'write/modify operations are not permitted' };
  }

  // Multiple statements (semicolon attack)
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/;\s*\S/.test(stripped)) {
    return { ok: false, reason: 'multiple statements are not permitted' };
  }

  const normalized = cmd.replace(/\s+/g, ' ').toUpperCase().trimStart();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    return { ok: false, reason: 'only SELECT and WITH...SELECT queries are permitted' };
  }

  // Try AST parse (BigQuery dialect for BQ, default for Supabase/pg)
  let ast;
  try {
    const opt = target === 'bigquery' ? { database: 'BigQuery' } : {};
    ast = sqlParser.astify(cmd, opt);
  } catch {
    // Parser failed — fall back to regex checks (still safe because HARD_BLOCKED already ran)
    ast = null;
  }

  if (ast) {
    const stmts = Array.isArray(ast) ? ast : [ast];

    // Only SELECT type allowed
    for (const s of stmts) {
      if (s.type && s.type.toLowerCase() !== 'select') {
        return { ok: false, reason: `${s.type} statements are not permitted` };
      }
    }

    // Check tables against allowlist
    const { tables: allowlistTables } = loadAllowlist();
    const allowed = target === 'bigquery' ? allowlistTables.bigquery : allowlistTables.supabase;
    const referencedTables = extractTablesFromAst(ast);

    for (const ref of referencedTables) {
      const fullName = ref.db ? `${ref.db}.${ref.table}` : ref.table;

      // Block INFORMATION_SCHEMA / system tables on Supabase
      if (target === 'supabase' && /information_schema|pg_catalog|pg_tables/i.test(fullName)) {
        return { ok: false, reason: 'access to system schema is not permitted' };
      }

      // Block cross-project refs in BigQuery
      if (target === 'bigquery' && ref.db && !ref.db.includes('frido-429506')) {
        return { ok: false, reason: `cross-project table reference '${fullName}' is not permitted` };
      }

      const isAllowedTable = allowed.some(t => {
        const tName = t.includes('.') ? t.split('.').pop().toLowerCase() : t.toLowerCase();
        return ref.table.toLowerCase() === tName || fullName.toLowerCase().includes(t.toLowerCase());
      });

      if (!isAllowedTable && referencedTables.length > 0) {
        // Check if it's a schema-inspection query (ok for BQ)
        if (target === 'bigquery' && /INFORMATION_SCHEMA/i.test(cmd)) continue;
        return { ok: false, reason: `table '${fullName}' is not in the allowlist` };
      }
    }

    // PII column check — only when specific columns are selected (not SELECT *)
    const selectedCols = extractColumnsFromAst(ast);
    if (!selectedCols.includes('*')) {
      for (const col of selectedCols) {
        if (PII_COLUMNS.includes(col)) {
          return { ok: false, reason: `column '${col}' contains PII and cannot be selected` };
        }
      }
    }
  }

  return { ok: true };
}

export function isAllowed(command, target) {
  const cmd = command.trim();

  if (target === 'bigquery' || target === 'supabase') {
    return checkSql(cmd, target).ok;
  }

  if (target === 'repo') {
    if (!ALLOWED_REPO_CMDS.test(cmd) && !ALLOWED_REPO_BARE.test(cmd)) return false;
    if (BLOCKED_SHELL.test(cmd)) return false;
    if (/\.env|sa_key|secret|credential|password|token/i.test(cmd)) return false;
    // Inventory formula is locked in CLAUDE.md — reading _inventory_shared.js wastes
    // iterations and causes timeouts. Block it so Claude uses the locked SQL directly.
    if (/_inventory_shared/i.test(cmd)) return false;
    return true;
  }

  return false;
}

export function blockReason(command, target) {
  const cmd = command.trim();

  if (target === 'bigquery' || target === 'supabase') {
    return checkSql(cmd, target).reason || 'query not permitted';
  }

  if (target === 'repo') {
    if (!ALLOWED_REPO_CMDS.test(cmd) && !ALLOWED_REPO_BARE.test(cmd))
      return 'only cat, ls, head, grep are permitted';
    if (BLOCKED_SHELL.test(cmd))
      return 'pipes, redirects, and shell execution are not permitted';
    if (/\.env|sa_key|secret|credential|password|token/i.test(cmd))
      return 'access to secrets/config files is not permitted';
    if (/_inventory_shared/i.test(cmd))
      return 'inventory formula is locked in CLAUDE.md — use the exact SQL template there, do not read _inventory_shared.js';
  }

  return 'command not permitted';
}
