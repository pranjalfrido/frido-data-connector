import { runBigQuery } from './lib/bigquery.js';
import { runRepo } from './lib/repo.js';

// Dashboard shows:
// Gross Inc GST = ₹24.38 Cr
// Net Rev Exc GST = ₹17.81 Cr
// RTO% = 6.8%, CIR% = 6.4%, Cancel% = 4.5%, Exchange% = 6.1%, Returns% = 17.7%
// My query got: Gross Inc GST = ₹24.49 Cr, Net Rev = ₹19.02 Cr

// Differences to investigate:
// 1. Dashboard shows Exchange% 6.1% — my query EXCLUDED exchange from deductions. Dashboard may include it.
// 2. Dashboard Gross = 24.38 Cr, mine = 24.49 Cr — slight gross rev diff too
// 3. Dashboard Returns% = 17.7% (RTO+CIR+Cancelled+Exchange?) — much higher than my 4.1+3.87+4.53

// Step 1: Read exactly what computeNetRevenueMeasures does with exchange
const bqFile = await runRepo('cat api/_bq.js');
const lines = bqFile.split('\n');
const measStart = lines.findIndex(l => l.includes('export function computeNetRevenueMeasures'));
console.log('=== computeNetRevenueMeasures ===');
console.log(lines.slice(measStart, measStart + 60).join('\n'));

// Step 2: Check what SubChannels are excluded for D2C
const buildQueryStart = lines.findIndex(l => l.includes('export function buildQuery'));
console.log('\n=== buildQuery D2C filter ===');
console.log(lines.slice(buildQueryStart, buildQueryStart + 80).join('\n'));
