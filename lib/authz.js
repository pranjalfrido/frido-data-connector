import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const access = JSON.parse(readFileSync(join(__dirname, '../config/access.json'), 'utf8'));

export function authorizeToolCall(user, toolName, target) {
  const roleConfig = access.roles[user.role];
  if (!roleConfig) {
    return { ok: false, message: `Unknown role '${user.role}'. Contact accounts@myfrido.com.` };
  }

  if (!roleConfig.allowed_tools.includes(toolName)) {
    return { ok: false, message: `Your role (${user.role}) cannot use the '${toolName}' tool.` };
  }

  if (target && roleConfig.allowed_targets && !roleConfig.allowed_targets.includes(target)) {
    return { ok: false, message: `Your role (${user.role}) does not have access to ${target} data.` };
  }

  return { ok: true };
}

export function getAllowedTablesForRole(role) {
  return access.roles[role]?.allowed_tables || [];
}

export function getDeniedColumnsForRole(role) {
  return access.roles[role]?.denied_columns || [];
}
