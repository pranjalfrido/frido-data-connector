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

## Workflow (follow strictly):
1. For inventory questions → query Supabase (inv_snapshot table)
2. For sales/revenue questions → query BigQuery (production.fact_all_platform_sales_report)
3. For logistics questions → query BigQuery (production.Clickpost_Shipment_Tracking_Report)
4. For formula/calculation questions → read repo (api/_bq.js or api/_inventory_shared.js)
5. Always check real column names if unsure — run SELECT * LIMIT 1 first

## Key tables:
- BigQuery: \`frido-429506.production.fact_all_platform_sales_report\` (sales/returns/revenue)
- BigQuery: \`frido-429506.production.Clickpost_Shipment_Tracking_Report\` (logistics)
- Supabase: \`inv_snapshot\` (current inventory by SKU + facility)
- Supabase: \`sales_window\` (recent daily sales for avg calc)

## Default assumptions (unless user specifies):
- Date range: last 30 days
- Exclude: Credit Notes, Amazon RTV, _EX suffix orders, Shopify International
- Inventory columns: rtd_invt, raw_invt, raw_blocked_invt (NOT rtd_qty)
- BQ SKU column: masterskucode (lowercase), payment: payment_type

## CRITICAL revenue calculation rules (NEVER break these):
- Gross Revenue (Inc GST) = SUM(SellingPrice_Inc_GST) — this column is ALREADY the line total, NEVER multiply by ItemQty
- Gross Revenue (Ex GST) = SUM(SellingPrice_Ex_GST) — same, already a line total
- Net Revenue = Gross Revenue minus returns (filter Order_Status != 'Return' or use separate return rows)
- Units sold = SUM(ItemQty)
- Orders = COUNT(DISTINCT OrderId)
- To exclude _EX orders: AND OrderId NOT LIKE '%\\_EX%' (NOT masterskucode — OrderId is the correct column)
- D2C Shopify filter: Channel = 'Shopify' AND Channel_Group = 'D2C'
- Date column for sales: DATE(OrderDate) or just OrderDate BETWEEN '...' AND '...'

If the user asks anything about Frido data, stock, sales, or business metrics — call run_command immediately, do not ask for clarification first.`;

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

USE FOR: stock levels, inventory, DOI, warehouse quantities, revenue, gross revenue, net revenue, sales, orders, units, returns, RTO, CIR, return rate, delivery rate, logistics, courier, ads, ROAS, spend, any Frido KPI or metric.

Runs a read-only command against Frido live data:
- target=bigquery → SQL query for sales/revenue/returns/logistics (table: frido-429506.production.fact_all_platform_sales_report)
- target=supabase → SQL query for inventory data (table: inv_snapshot, columns: rtd_invt raw_invt raw_blocked_invt)
- target=repo → cat/ls/head/grep commands to read dashboard formula code from GitHub

ALWAYS explore before answering: check schema with SELECT * LIMIT 1, verify column names, then run real query.`,
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
- target=repo → cat/ls/grep commands to read dashboard formula code`,
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
