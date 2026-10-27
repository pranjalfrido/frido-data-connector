import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE = readFileSync(path.join(__dirname, 'knowledge', 'CLAUDE.md'), 'utf8');

const TOOL_DESCRIPTION = `Run a read-only command against Frido live data. Use for ANY Frido business question — stock, revenue, returns, logistics, courier, ads, or any metric.
- target=bigquery → SQL query against BigQuery tables
- target=supabase → SQL query against Supabase tables
- target=repo → cat/ls/head/grep to read dashboard formula code from GitHub`;

function buildSystemPrompt() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const today = ist.toISOString().slice(0, 10);
  return `Today's date is ${today} (IST). Use this as the reference for all date calculations — never hardcode a year or guess the date.

You have access to the run_command tool which connects to Frido's live business data. NEVER answer business questions from memory — always use run_command to query live data first.

${KNOWLEDGE}`;
}

// Single tool executor — used by both MCP and /chat
async function executeTool(user, command, target) {
  const start = Date.now();

  const authzResult = authorizeToolCall(user, 'run_command', target);
  if (!authzResult.ok) {
    writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'denied', denialReason: authzResult.message, latencyMs: Date.now() - start });
    log({ user: user.email, role: user.role, target, command, allowed: false, reason: authzResult.message, duration: Date.now() - start });
    return { ok: false, text: authzResult.message };
  }

  if (!isAllowed(command, target)) {
    const reason = blockReason(command, target);
    writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'denied', denialReason: reason, latencyMs: Date.now() - start });
    log({ user: user.email, role: user.role, target, command, allowed: false, reason, duration: Date.now() - start });
    return { ok: false, text: `Not permitted: ${reason}` };
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
    return { ok: true, text: output };
  } catch (err) {
    const reqId = Math.random().toString(36).slice(2, 10);
    const latencyMs = Date.now() - start;
    writeAuditLog({ user, tool: 'run_command', target, command, outcome: 'error', denialReason: err.message, latencyMs, reqId });
    log({ user: user.email, role: user.role, target, command, allowed: true, error: err.message, reqId, duration: latencyMs });
    return { ok: false, text: `Query failed (ref: ${reqId}). Please try rephrasing or contact accounts@myfrido.com.` };
  }
}

function createMcpServer(user) {
  const server = new McpServer({ name: 'frido-data-connector', version: '1.0.0' });

  server.resource(
    'instructions',
    'frido://instructions',
    { mimeType: 'text/plain' },
    async () => ({
      contents: [{ uri: 'frido://instructions', text: buildSystemPrompt(), mimeType: 'text/plain' }],
    })
  );

  server.tool(
    'run_command',
    TOOL_DESCRIPTION,
    {
      command: z.string().describe('The SQL query or file command to run'),
      target: z.enum(['bigquery', 'supabase', 'repo']).describe('bigquery = sales/logistics/ads data, supabase = inventory data, repo = dashboard formula code on GitHub'),
    },
    async ({ command, target }) => {
      const result = await executeTool(user, command, target);
      return { content: [{ type: 'text', text: result.text }] };
    }
  );

  return server;
}

const PORT = process.env.PORT || 8080;

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: 'frido-data-connector' }));
    return;
  }

  if (req.url === '/mcp') {
    const authResult = await validateRequest(req).catch(() => ({
      ok: false, status: 500, message: 'Auth check failed. Try again later.'
    }));
    if (!authResult.ok) {
      res.writeHead(authResult.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: authResult.message }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer(authResult.user);
    res.on('close', () => { server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, await getBody(req));
    return;
  }

  if (req.method === 'OPTIONS' && req.url === '/chat') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
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

    const budget = checkBudget();
    if (!budget.ok) {
      await sendLimitEmail(authResult.user);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Monthly AI budget of $300 has been reached. Frido Pulse will resume next month. Contact data.team@myfrido.com to raise the limit.' }));
      return;
    }

    const user = authResult.user;
    const anthropic = new Anthropic({ apiKey });

    const lastUserMsg = messages[messages.length - 1]?.content ?? messages[messages.length - 1]?.text ?? '';
    const isComplex = /compar|breakdown|analys|trend|p&l|profit|loss|why|explain|forecast|correlat|multi|across|vs\b|versus|deep/i.test(lastUserMsg);
    const model = isComplex ? 'claude-opus-4-7' : 'claude-sonnet-4-6';

    const tools = [{
      name: 'run_command',
      description: TOOL_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'SQL query or shell command to run' },
          target: { type: 'string', enum: ['bigquery', 'supabase', 'repo'], description: 'Data source to query' },
        },
        required: ['command', 'target'],
      },
    }];

    try {
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
          system: buildSystemPrompt(),
          tools,
          messages: loopMessages,
        };
        if (isComplex) reqParams.thinking = { type: 'enabled', budget_tokens: 10000 };
        const response = await anthropic.messages.create(reqParams);

        totalInputTokens += response.usage?.input_tokens || 0;
        totalOutputTokens += response.usage?.output_tokens || 0;

        for (const block of response.content) {
          if (block.type === 'text') finalText = block.text;
          if (block.type === 'tool_use' && block.input?.command) usedSql = block.input.command;
        }

        if (response.stop_reason !== 'tool_use') break;

        // Execute tool calls using the same executeTool() as MCP
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const { command, target } = block.input;
          const result = await executeTool(user, command, target);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result.text });
        }

        loopMessages = [
          ...loopMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ];
      }

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
