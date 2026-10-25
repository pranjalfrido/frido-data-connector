import { sendAlertEmail } from './mailer.js';

// Pricing per million tokens (USD)
const PRICING = {
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-opus-4-7':   { input: 15, output: 75 },
};

const MONTHLY_LIMIT_USD  = 300;
const WARNING_THRESHOLD  = 280; // alert at $280

// In-memory store — resets when container restarts.
// Cloud Run containers typically restart monthly or on redeploy,
// which aligns well with calendar-month resets.
let state = {
  month: currentMonth(),
  totalCost: 0,
  queryCount: 0,
  warningSent: false,
  limitSent: false,
};

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

function resetIfNewMonth() {
  const m = currentMonth();
  if (state.month !== m) {
    state = { month: m, totalCost: 0, queryCount: 0, warningSent: false, limitSent: false };
  }
}

// Returns cost in USD for a single API response
export function calcCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// Call after every successful /chat response
export async function trackUsage({ model, inputTokens, outputTokens, user }) {
  resetIfNewMonth();

  const cost = calcCost(model, inputTokens, outputTokens);
  state.totalCost += cost;
  state.queryCount += 1;

  // Warning at $280
  if (!state.warningSent && state.totalCost >= WARNING_THRESHOLD) {
    state.warningSent = true;
    sendAlertEmail(
      '⚠️ Frido Pulse — Cost Warning ($280 reached)',
      `<p>Monthly AI spend has reached <strong>$${state.totalCost.toFixed(2)}</strong> (limit: $${MONTHLY_LIMIT_USD}).</p>
       <p>Queries this month: <strong>${state.queryCount}</strong></p>
       <p>Last user: <strong>${user?.email || 'unknown'}</strong></p>
       <p>Frido Pulse will stop at $${MONTHLY_LIMIT_USD}. Review usage or raise the limit in <code>lib/costTracker.js</code>.</p>`
    ).catch(() => {});
  }
}

// Call before processing a query — returns { ok, cost }
export function checkBudget() {
  resetIfNewMonth();
  if (state.totalCost >= MONTHLY_LIMIT_USD) {
    return { ok: false, spent: state.totalCost };
  }
  return { ok: true, spent: state.totalCost };
}

// Send hard-limit email once
export async function sendLimitEmail(user) {
  if (state.limitSent) return;
  state.limitSent = true;
  await sendAlertEmail(
    '🚫 Frido Pulse — Monthly Limit Reached ($300)',
    `<p>Monthly AI spend has hit the <strong>$${MONTHLY_LIMIT_USD} limit</strong>. Frido Pulse queries are now blocked for the rest of this month.</p>
     <p>Total spend: <strong>$${state.totalCost.toFixed(2)}</strong> across <strong>${state.queryCount} queries</strong>.</p>
     <p>Last user who triggered the limit: <strong>${user?.email || 'unknown'}</strong></p>
     <p>To raise the limit, update <code>MONTHLY_LIMIT_USD</code> in <code>lib/costTracker.js</code> and redeploy.</p>`
  ).catch(() => {});
}

export function getStats() {
  resetIfNewMonth();
  return { totalCost: state.totalCost, queryCount: state.queryCount, month: state.month };
}
