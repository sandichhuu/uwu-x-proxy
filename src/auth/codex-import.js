// Adapted from codex-claude-proxy/src/account-manager.js#importFromCodex.
// Source is read-only; credentials are saved only in x-proxy's encrypted store.
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openAIClaims } from './oauth.js';
import { id } from '../storage/store.js';
export function importFromCodex(store, { codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  let source;
  try { source = fs.readFileSync(join(codexHome, 'auth.json'), 'utf8'); }
  catch (e) { throw Object.assign(new Error(e.code === 'ENOENT' ? 'No Codex auth.json found. Sign in with Codex on the machine running x-proxy first.' : 'Cannot read Codex auth.json. Check file permissions.'), { status: 400 }); }
  let auth;
  try { auth = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(new Error('Codex auth.json is not valid JSON. Sign in with Codex again.'), { status: 400 }); }
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) throw Object.assign(new Error('No ChatGPT tokens in Codex auth.json. API-key-only or keyring-only logins cannot be imported from this file.'), { status: 400 });
  for (const key of ['refresh_token', 'id_token', 'account_id']) if (tokens[key] != null && typeof tokens[key] !== 'string') throw Object.assign(new Error('Invalid token fields in Codex auth.json'), { status: 400 });
  const info = openAIClaims(tokens.access_token), identity = openAIClaims(tokens.id_token || '');
  const accountId = tokens.account_id || info.accountId || identity.accountId, email = info.email || identity.email;
  if (!accountId && !email) throw Object.assign(new Error('Codex tokens contain no account identity. Sign in with Codex again.'), { status: 400 });
  const old = store.list('accounts').find(a => a.provider === 'openai' && (accountId ? a.accountId === accountId : a.email === email));
  const saved = store.upsert('accounts', { ...old, id: old?.id || id('account'), provider: 'openai', email, accountId, planType: info.planType, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || old?.refreshToken, idToken: tokens.id_token || old?.idToken, expiresAt: info.expiresAt || 0, source: 'imported', enabled: old?.enabled ?? true, createdAt: old?.createdAt || new Date().toISOString() });
  return { status: 'completed', accountId: saved.id, email: saved.email, message: 'Imported account from local Codex.' };
}
