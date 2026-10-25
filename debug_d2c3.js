import { runBigQuery } from './lib/bigquery.js';
import { runRepo } from './lib/repo.js';

// Read the actual bq.js to see what query the dashboard fires for D2C overall
const bqJs = await runRepo('cat api/bq.js');
const lines = bqJs.split('\n');

// Find where D2C / shopify overall query is built
const shIdx = lines.findIndex(l => l.includes('shopify') || l.includes('Shopify') && l.includes('overall'));
console.log('Shopify overall section (bq.js):');
console.log(lines.slice(shIdx, shIdx + 60).join('\n'));

// Also check what the base CTE looks like — what does buildQuery actually output
// specifically any additional WHERE clauses always present
const baseIdx = lines.findIndex(l => l.includes('buildQuery') && l.includes('d2c'));
console.log('\nbuildQuery d2c call:');
console.log(lines.slice(baseIdx, baseIdx + 20).join('\n'));
