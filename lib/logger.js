import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, '..', 'logs');
try { mkdirSync(logDir, { recursive: true }); } catch {}

export function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  const file = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.ndjson`);
  try { appendFileSync(file, line); } catch {}
  if (process.env.LOG_STDOUT === 'true') process.stderr.write(line);
}
