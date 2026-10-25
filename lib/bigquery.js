import { BigQuery } from '@google-cloud/bigquery';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

let _bq;
function getBQ() {
  if (_bq) return _bq;
  const keyPath = process.env.GCP_SA_KEY_FILE;
  const keyJson = process.env.GCP_SA_KEY;
  if (keyJson) {
    const key = JSON.parse(keyJson);
    _bq = new BigQuery({ projectId: key.project_id, credentials: key });
  } else if (keyPath) {
    const key = JSON.parse(readFileSync(keyPath, 'utf8'));
    _bq = new BigQuery({ projectId: key.project_id, keyFilename: keyPath });
  } else {
    throw new Error('No BigQuery credentials: set GCP_SA_KEY or GCP_SA_KEY_FILE');
  }
  return _bq;
}

const MAX_BYTES_BILLED = 5 * 1024 * 1024 * 1024; // 5 GB cap

export async function runBigQuery(sql) {
  const bq = getBQ();
  const [job] = await bq.createQueryJob({
    query: sql,
    maximumBytesBilled: String(MAX_BYTES_BILLED),
    useLegacySql: false,
  });
  const [rows] = await job.getQueryResults();
  if (rows.length === 0) return 'No rows returned.';
  // Return as pretty table string (first 500 rows)
  const capped = rows.slice(0, 500);
  const headers = Object.keys(capped[0]);
  const lines = [
    headers.join('\t'),
    ...capped.map(r => headers.map(h => {
      const v = r[h];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'object' && v.value !== undefined) return v.value; // BigQuery date/numeric
      return String(v);
    }).join('\t')),
  ];
  if (rows.length > 500) lines.push(`\n[Showing 500 of ${rows.length} rows]`);
  return lines.join('\n');
}
