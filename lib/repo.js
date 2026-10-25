// Reads files live from GitHub (public repo, no token needed)
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const GITHUB_REPO = process.env.GITHUB_REPO || 'pranjalfrido/Unified_Dashboard_Frido';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''; // optional, for private repo

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scopePath = path.join(__dirname, '..', 'knowledge', 'repo-scope.json');

function getAllowedPaths() {
  return JSON.parse(readFileSync(scopePath, 'utf8')).allowed;
}

function isPathAllowed(filePath) {
  const allowed = getAllowedPaths();
  return allowed.some(a => {
    if (a.endsWith('/*')) {
      const prefix = a.slice(0, -2);
      return filePath.startsWith(prefix + '/') || filePath === prefix;
    }
    if (a.endsWith('/**')) {
      const prefix = a.slice(0, -3);
      return filePath.startsWith(prefix + '/') || filePath === prefix;
    }
    return filePath === a || filePath.startsWith(a + '/');
  });
}

async function fetchGitHubFile(filePath) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
  const headers = { Accept: 'application/vnd.github.v3.raw', 'User-Agent': 'frido-data-connector' };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub fetch failed (${res.status}): ${filePath}`);
  return res.text();
}

async function fetchGitHubDir(dirPath) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${dirPath}?ref=${GITHUB_BRANCH}`;
  const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'frido-data-connector' };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub fetch failed (${res.status}): ${dirPath}`);
  const items = await res.json();
  return items.map(i => `${i.type === 'dir' ? 'd' : '-'} ${i.name}`).join('\n');
}

export async function runRepo(command) {
  const cmd = command.trim();

  // ls <path>
  const lsMatch = cmd.match(/^ls\s+(.+)$/);
  if (lsMatch || cmd === 'ls') {
    const dirPath = lsMatch ? lsMatch[1].trim().replace(/^\//, '') : '';
    return fetchGitHubDir(dirPath);
  }

  // cat <file>
  const catMatch = cmd.match(/^cat\s+(.+)$/);
  if (catMatch) {
    const filePath = catMatch[1].trim().replace(/^\//, '');
    if (!isPathAllowed(filePath)) return `Not permitted: ${filePath} is outside the allowed repo scope`;
    return fetchGitHubFile(filePath);
  }

  // head -n <N> <file> or head <file>
  const headMatch = cmd.match(/^head(?:\s+-n\s+(\d+))?\s+(.+)$/);
  if (headMatch) {
    const n = headMatch[1] ? parseInt(headMatch[1]) : 50;
    const filePath = headMatch[2].trim().replace(/^\//, '');
    if (!isPathAllowed(filePath)) return `Not permitted: ${filePath} is outside the allowed repo scope`;
    const content = await fetchGitHubFile(filePath);
    return content.split('\n').slice(0, n).join('\n');
  }

  // grep <pattern> <file> or grep -r <pattern> <dir>
  const grepMatch = cmd.match(/^grep\s+(-r\s+)?(.+?)\s+(.+)$/);
  if (grepMatch) {
    const recursive = !!grepMatch[1];
    const pattern = grepMatch[2].replace(/^['"]|['"]$/g, '');
    const targetPath = grepMatch[3].trim().replace(/^\//, '');
    if (!recursive) {
      if (!isPathAllowed(targetPath)) return `Not permitted: ${targetPath} is outside the allowed repo scope`;
      const content = await fetchGitHubFile(targetPath);
      const regex = new RegExp(pattern, 'i');
      const matches = content.split('\n').filter(l => regex.test(l));
      return matches.length ? matches.join('\n') : 'No matches found.';
    }
    // For recursive grep, search allowed paths only
    return `Recursive grep not yet supported via GitHub API — use cat on specific files instead.`;
  }

  // find -name <pattern>
  const findMatch = cmd.match(/^find\s+.*-name\s+['"]?(.+?)['"]?$/);
  if (findMatch) {
    return `find is not supported via GitHub API — use ls to explore directories instead.`;
  }

  return `Not permitted: unrecognized repo command. Allowed: cat, ls, head, grep`;
}
