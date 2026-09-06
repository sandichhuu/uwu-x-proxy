// Portable backup/restore for OAuth accounts (google / openai).
//
// Export shape (versioned):
//   { app: 'uwu-x-proxy', version: 1, exportedAt, provider,
//     accounts: [{ email, accountId?, refreshToken, projectId?, enabled }] }
//
// Import additionally accepts ecosystem formats:
//   - flat array: [{ email, refresh_token }]
//   - wrapped object: { accounts: [...] }
// Field names accept snake_case and camelCase. Only long-lived credentials
// are transferred; short-lived access tokens refresh on demand after import,
// and usage/quota is re-discovered.
export const TRANSFER_VERSION = 1;
export const TRANSFERABLE_PROVIDERS = ['google', 'openai'];

export function buildAccountExport(provider, accounts) {
  if (!TRANSFERABLE_PROVIDERS.includes(provider)) throw Object.assign(new Error('Provider does not support transfer'), { status: 400 });
  return {
    app: 'uwu-x-proxy',
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    provider,
    accounts: (accounts || [])
      .filter(a => a && a.provider === provider)
      .map(a => ({
        email: a.email || undefined,
        accountId: a.accountId || undefined,
        refreshToken: a.refreshToken || undefined,
        projectId: a.projectId || undefined,
        enabled: a.enabled !== false
      }))
  };
}

const asString = value => (typeof value === 'string' && value ? value : undefined);

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `Entry ${index}: must be an object` };
  const refreshToken = asString(raw.refreshToken) || asString(raw.refresh_token);
  if (!refreshToken || refreshToken.length < 8) return { error: `Entry ${index}: refresh token is missing or invalid` };
  return {
    entry: {
      email: asString(raw.email),
      accountId: asString(raw.accountId) || asString(raw.account_id),
      refreshToken,
      projectId: asString(raw.projectId) || asString(raw.project_id) || asString(raw.project),
      enabled: raw.enabled !== false
    }
  };
}

export function normalizeAccountImport(provider, input) {
  const entries = [], errors = [];
  if (!TRANSFERABLE_PROVIDERS.includes(provider)) return { entries, errors: ['Unsupported provider'] };
  let list;
  if (Array.isArray(input)) list = input;
  else if (input && typeof input === 'object' && Array.isArray(input.accounts)) list = input.accounts;
  else return { entries, errors: ['Body must be a JSON array or an object with an accounts array'] };
  if (list.length > 1000) return { entries, errors: ['Too many accounts (max 1000 per import)'] };
  const seen = new Set();
  list.forEach((raw, i) => {
    const { entry, error } = normalizeEntry(raw, i);
    if (error) { errors.push(error); return; }
    if (seen.has(entry.refreshToken)) { errors.push(`Entry ${i}: duplicate of an earlier entry in this file`); return; }
    seen.add(entry.refreshToken);
    entries.push(entry);
  });
  return { entries, errors };
}

// Find the stored account an imported entry should merge into: accountId,
// then email, then identical refresh token (re-import idempotence).
export function findImportTarget(accounts, provider, entry) {
  const pool = (accounts || []).filter(a => a && a.provider === provider);
  const email = entry.email?.toLowerCase();
  return pool.find(a => (entry.accountId && a.accountId && a.accountId === entry.accountId)
    || (email && a.email?.toLowerCase() === email)
    || (a.refreshToken && a.refreshToken === entry.refreshToken));
}
