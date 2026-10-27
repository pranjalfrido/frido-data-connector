import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { runBigQuery } from './lib/bigquery.js';
import { runSupabase } from './lib/supabase.js';
import { runRepo } from './lib/repo.js';
import { isAllowed, blockReason } from './lib/safety.js';
import { log } from './lib/logger.js';
import { validateRequest } from './lib/auth.js';
import { authorizeToolCall } from './lib/authz.js';
import { writeAuditLog } from './lib/audit.js';
import { checkBudget, trackUsage, sendLimitEmail, getStats } from './lib/costTracker.js';

const SYSTEM_INSTRUCTIONS = `# Frido Data Connector — MANDATORY INSTRUCTIONS

You have access to the run_command tool which connects to Frido's live business data.

## CRITICAL: You MUST use run_command for ANY question about:
- Stock, inventory, DOI, days of inventory, warehouse stock, SKU availability, RTD, raw stock
- Revenue, gross revenue, net revenue, sales, orders, units sold, GMV
- Returns, RTO, CIR, return rate, delivery rate, logistics, courier performance
- Ads, ROAS, spend, CAC, marketing performance
- Any Frido business metric, product, channel, or operational data

## NEVER answer from memory or training data. ALWAYS query live data first.

## MANDATORY workflow — follow this EXACTLY every time:
1. ALWAYS run SELECT * FROM <table> LIMIT 1 first to see real column names before writing any query
2. Then run your actual data query using only columns that exist in the schema
3. NEVER assume a column does not exist — always check schema first
4. NEVER tell the user a column or data is unavailable without checking the schema first

## Table routing:
- Inventory → Supabase: inv_snapshot
- Sales / Revenue / Returns → BigQuery: frido-429506.production.fact_all_platform_sales_report
- Logistics / Courier / Shipments / Delivery Cost / Freight → BigQuery: frido-429506.production.Clickpost_Shipment_Tracking_Report
- Formula / calculation logic → repo: api/_bq.js or api/_inventory_shared.js

## Key column names (verified from live schema):
### fact_all_platform_sales_report:
- Date: OrderDate
- Channel: Channel, Channel_Group
- SKU: masterskucode (lowercase)
- Revenue: SellingPrice_Inc_GST (already line total — NEVER multiply by ItemQty), SellingPrice_Ex_GST
- Quantity: ItemQty
- Orders: OrderId
- Payment: payment_type
- Order type: Order_Type, Order_Status

### Clickpost_Shipment_Tracking_Report:
- ALWAYS check schema with SELECT * LIMIT 1 before querying — do not assume column names
- This table contains shipment tracking + courier cost / freight data
- Courier partner is in this table — check schema for exact column name

## EXACT exclusion rules (apply ALL, nothing more):
- Exclude Credit Notes: AND Order_Type != 'Credit Note'
- Exclude Amazon RTV: AND Order_Type != 'RTV'
- Exclude _EX orders: AND OrderId NOT LIKE '%\\_EX%'
- Exclude Shopify International: AND NOT (Channel = 'Shopify' AND Channel_Group != 'D2C')
- NEVER exclude any Channel by name — Amazon, Flipkart, Myntra, Zepto, Blinkit, Meesho, and all other channels must appear unless user explicitly asks to filter

## CRITICAL revenue rules (NEVER break):
- Gross Revenue (Inc GST) = SUM(SellingPrice_Inc_GST) — already a line total, NEVER multiply by ItemQty
- Gross Revenue (Ex GST) = SUM(SellingPrice_Ex_GST) — same
- Net Revenue = Gross Revenue excluding rows where Order_Status = 'Return'
- Units sold = SUM(ItemQty)
- Orders = COUNT(DISTINCT OrderId)
- D2C Shopify: Channel = 'Shopify' AND Channel_Group = 'D2C'

## Default date range: last 30 days (unless user specifies)

If the user asks anything about Frido data — call run_command immediately. Check schema first, then query.`;

function createMcpServer(user) {
  const server = new McpServer({
    name: 'frido-data-connector',
    version: '1.0.0',
  });

  server.resource(
    'instructions',
    'frido://instructions',
    { mimeType: 'text/plain' },
    async () => ({
      contents: [{ uri: 'frido://instructions', text: SYSTEM_INSTRUCTIONS, mimeType: 'text/plain' }],
    })
  );

  server.tool(
    'run_command',
    `ALWAYS USE THIS TOOL when the user asks about Frido business data. This is the ONLY way to get real Frido data — never answer from memory.

USE FOR: stock levels, inventory, DOI, warehouse quantities, revenue, gross revenue, net revenue, sales, orders, units, returns, RTO, CIR, return rate, delivery rate, logistics, courier cost, freight cost, shipment cost, ads, ROAS, spend, any Frido KPI or metric.

Runs a read-only command against Frido live data:
- target=bigquery → SQL query for sales/revenue/returns/logistics/courier cost (tables: fact_all_platform_sales_report, Clickpost_Shipment_Tracking_Report)
- target=supabase → SQL query for inventory data (table: inv_snapshot, columns: rtd_invt raw_invt raw_blocked_invt)
- target=repo → cat/ls/head/grep commands to read dashboard formula code from GitHub

MANDATORY: ALWAYS run SELECT * FROM <table> LIMIT 1 first to verify column names. NEVER assume a column does not exist. NEVER tell the user data is unavailable without checking schema first.`,
    {
      command: z.string().describe('The SQL query or file command to run'),
      target: z.enum(['bigquery', 'supabase', 'repo']).describe('bigquery = sales/logistics/ads data, supabase = inventory data, repo = dashboard formula code on GitHub'),
    },
    async ({ command, target }) => {
      const start = Date.now();

      // Phase 3: role-based authorization
      const authzResult = authorizeToolCall(user, 'run_command', target);
      if (!authzResult.ok) {
        writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'denied', denialReason: authzResult.message, latencyMs: Date.now() - start });
        log({ user: user.email, role: user.role, target, command, allowed: false, reason: authzResult.message, duration: Date.now() - start });
        return { content: [{ type: 'text', text: authzResult.message }] };
      }

      // Phase 4: SQL safety wall
      const allowed = isAllowed(command, target);
      if (!allowed) {
        const reason = blockReason(command, target);
        writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'denied', denialReason: reason, latencyMs: Date.now() - start });
        log({ user: user.email, role: user.role, target, command, allowed: false, reason, duration: Date.now() - start });
        return { content: [{ type: 'text', text: `Not permitted: ${reason}` }] };
      }

      try {
        let result;
        if (target === 'bigquery') result = await runBigQuery(command);
        else if (target === 'supabase') result = await runSupabase(command);
        else result = await runRepo(command);

        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const truncated = text.length > 50000;
        const output = truncated ? text.slice(0, 50000) + '\n\n[truncated: true]' : text;
        const latencyMs = Date.now() - start;

        writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'ok', rowsReturned: text.split('\n').length, latencyMs });
        log({ user: user.email, role: user.role, target, command, allowed: true, resultSize: text.length, truncated, duration: latencyMs });
        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        const reqId = Math.random().toString(36).slice(2, 10);
        const latencyMs = Date.now() - start;
        writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'error', denialReason: err.message, latencyMs, reqId });
        log({ user: user.email, role: user.role, target, command, allowed: true, error: err.message, reqId, duration: latencyMs });
        return { content: [{ type: 'text', text: `Query failed (ref: ${reqId}). Please try rephrasing or contact accounts@myfrido.com.` }] };
      }
    }
  );

  return server;
}

const PORT = process.env.PORT || 8080;

const httpServer = http.createServer(async (req, res) => {
  // Security headers on every response
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: 'frido-data-connector' }));
    return;
  }

  if (req.url === '/mcp') {
    // Phase 1: validate Azure AD token on every MCP request
    const authResult = await validateRequest(req).catch(err => ({
      ok: false, status: 500, message: 'Auth check failed. Try again later.'
    }));

    if (!authResult.ok) {
      res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: authResult.message }));
      return;
    }

    const user = authResult.user;

    // Stateless mode — new server+transport per request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer(user);

    res.on('close', () => { server.close().catch(() => {}); });

    await server.connect(transport);
    await transport.handleRequest(req, res, await getBody(req));
    return;
  }

  // /chat — dashboard Ask Frido endpoint
  if (req.method === 'POST' && req.url === '/chat') {
    // CORS for dashboard origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

    const authResult = await validateRequest(req).catch(() => ({
      ok: false, status: 500, message: 'Auth check failed.'
    }));
    if (!authResult.ok) {
      res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: authResult.message }));
      return;
    }

    const body = await getBody(req);
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'messages array required' }));
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Anthropic API key not configured yet.' }));
      return;
    }

    const user = authResult.user;
    const anthropic = new Anthropic({ apiKey });

    // Detect complex queries that need Opus + extended thinking
    const lastUserMsg = messages[messages.length - 1]?.text || messages[messages.length - 1]?.content || '';
    const isComplex = /compar|breakdown|analys|trend|p&l|profit|loss|why|explain|forecast|correlat|multi|across|vs\b|versus|deep/i.test(lastUserMsg);
    const model = isComplex ? 'claude-opus-4-7' : 'claude-sonnet-4-6';

    const tools = [
      {
        name: 'run_command',
        description: `ALWAYS USE THIS TOOL when the user asks about Frido business data. Runs a read-only command against Frido live data.
- target=bigquery → SQL for sales/revenue/returns/logistics
- target=supabase → SQL for inventory data (inv_snapshot table)
- target=repo → cat/ls/grep commands to read dashboard formula code
IMPORTANT: Never exclude channels by name. All channels (Amazon, Flipkart, Myntra, Zepto, Blinkit, Meesho, Shopify, Offline, etc.) must appear unless user asks to filter.`,
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'SQL query or shell command to run' },
            target: { type: 'string', enum: ['bigquery', 'supabase', 'repo'], description: 'Data source to query' },
          },
          required: ['command', 'target'],
        },
      },
    ];

    // Check monthly budget before calling Claude
    const budget = checkBudget();
    if (!budget.ok) {
      await sendLimitEmail(user);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Monthly AI budget of $300 has been reached. Frido Pulse will resume next month. Contact data.team@myfrido.com to raise the limit.` }));
      return;
    }

    try {
      // Agentic loop — keep calling Claude until no more tool calls
      let loopMessages = messages.map(m => ({ role: m.role, content: m.content ?? m.text }));
      let finalText = '';
      let usedSql = null;
      let iterations = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (iterations < 8) {
        iterations++;
        const reqParams = {
          model,
          max_tokens: isComplex ? 16000 : 4096,
          system: SYSTEM_INSTRUCTIONS,
          tools,
          messages: loopMessages,
        };
        // Extended thinking only on Opus
        if (isComplex) reqParams.thinking = { type: 'enabled', budget_tokens: 10000 };
        const response = await anthropic.messages.create(reqParams);

        // Accumulate token usage across all loop iterations
        totalInputTokens += response.usage?.input_tokens || 0;
        totalOutputTokens += response.usage?.output_tokens || 0;

        // Collect any text from this turn
        for (const block of response.content) {
          if (block.type === 'text') finalText = block.text;
          if (block.type === 'tool_use' && block.input?.command) usedSql = block.input.command;
        }

        if (response.stop_reason !== 'tool_use') break;

        // Execute all tool calls
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const { command, target } = block.input;

          const authzResult = authorizeToolCall(user, 'run_command', target);
          if (!authzResult.ok) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: authzResult.message });
            continue;
          }
          const allowed = isAllowed(command, target);
          if (!allowed) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Not permitted: ${blockReason(command, target)}` });
            continue;
          }

          try {
            let result;
            if (target === 'bigquery') result = await runBigQuery(command);
            else if (target === 'supabase') result = await runSupabase(command);
            else result = await runRepo(command);

            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            const output = text.length > 50000 ? text.slice(0, 50000) + '\n\n[truncated]' : text;
            writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'ok', latencyMs: 0 });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
          } catch (err) {
            const reqId = Math.random().toString(36).slice(2, 10);
            writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'error', denialReason: err.message, latencyMs: 0, reqId });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Query failed (ref: ${reqId})` });
          }
        }

        loopMessages = [
          ...loopMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ];
      }

      // Track total cost across all loop iterations
      await trackUsage({ model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, user }).catch(() => {});

      const stats = getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: finalText, sql: usedSql, model, monthlySpend: parseFloat(stats.totalCost.toFixed(4)) }));
    } catch (err) {
      console.error('Chat error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Chat failed. Please try again.' }));
    }
    return;
  }

  // /chat preflight
  if (req.method === 'OPTIONS' && req.url === '/chat') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function getBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
    });
  });
}

httpServer.listen(PORT, () => {
  console.log(`frido-data-connector listening on port ${PORT}`);
});
