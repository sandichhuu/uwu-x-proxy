import { oauthJson } from './json.js';
import { discoverProjectId } from './google/project.js';
import { createHash, randomBytes } from 'node:crypto';

const GOOGLE = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo', redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:51121/oauth-callback',
  scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs']
};
const OPENAI = {
  clientId: process.env.OPENAI_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann', authUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token', redirectUri: process.env.OPENAI_OAUTH_REDIRECT_URI || 'http://localhost:1455/auth/callback',
  scopes: ['openid', 'profile', 'email', 'offline_access']
};
export const oauthConfigs = { google: GOOGLE, openai: OPENAI };
const sessions = new Map();
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');
export function cancelOAuth(state) { sessions.delete(state); }
export function beginOAuth(provider, redirectUri = oauthConfigs[provider]?.redirectUri) {
  const config = Object.hasOwn(oauthConfigs, provider) && oauthConfigs[provider]; if (!config) throw Object.assign(new Error('Unknown OAuth provider'), { status: 404 });
  const state = randomBytes(16).toString('hex'), verifier = randomBytes(32).toString('base64url');
  sessions.set(state, { provider, verifier, redirectUri, createdAt: Date.now() });
  for (const [key, value] of sessions) if (Date.now() - value.createdAt > 10 * 60_000) sessions.delete(key);
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: config.scopes.join(' '), code_challenge: challenge(verifier), code_challenge_method: 'S256', state });
  if (provider === 'google') params.set('access_type', 'offline'), params.set('prompt', 'consent');
  else { params.set('id_token_add_organizations', 'true'); params.set('codex_cli_simplified_flow', 'true'); params.set('originator', 'codex_cli_rs'); params.set('prompt', 'login'); params.set('max_age', '0'); }
  return { provider, authorizationUrl: `${config.authUrl}?${params}`, state, redirectUri, expiresIn: 600 };
}
export function parseOAuthInput(input) {
  if (typeof input !== 'string' || input.trim().length < 10) throw Object.assign(new Error('A callback URL or authorization code is required'), { status: 400 });
  const value = input.trim();
  if (!/^https?:\/\//i.test(value)) return { code: value };
  const url = new URL(value); const oauthError = url.searchParams.get('error');
  if (oauthError) throw Object.assign(new Error(`OAuth authorization failed: ${oauthError}`), { status: 400 });
  const code = url.searchParams.get('code'); if (!code) throw Object.assign(new Error('Callback URL has no code'), { status: 400 });
  return { code, state: url.searchParams.get('state') || undefined };
}
function decodeJwt(token) { try { const part = token.split('.')[1]; return JSON.parse(Buffer.from(part, 'base64url')); } catch { return {}; } }
export function openAIClaims(token) {
  const payload = decodeJwt(token), auth = payload['https://api.openai.com/auth'] || {}, profile = payload['https://api.openai.com/profile'] || {};
  return { accountId: auth.chatgpt_account_id, planType: auth.chatgpt_plan_type || 'free', userId: auth.chatgpt_user_id || payload.sub, email: profile.email || payload.email, expiresAt: payload.exp ? payload.exp * 1000 : undefined };
}
async function tokenRequest(config, body, fetchImpl) {
  const response = await fetchImpl(config.tokenUrl, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const data = await oauthJson(response, 'OAuth token exchange'); if (!data.access_token) throw new Error('OAuth response did not contain an access token'); return data;
}
export async function completeOAuth(provider, input, requestedState, fetchImpl = fetch) {
  const parsed = parseOAuthInput(input), state = parsed.state || requestedState, session = sessions.get(state);
  if (!state || !session || session.provider !== provider || Date.now() - session.createdAt > 10 * 60_000) throw Object.assign(new Error('Invalid or expired OAuth state'), { status: 400 });
  if (parsed.state && requestedState && parsed.state !== requestedState) throw Object.assign(new Error('OAuth state mismatch'), { status: 400 });
  sessions.delete(state); const config = oauthConfigs[provider];
  const body = { grant_type: 'authorization_code', code: parsed.code, redirect_uri: session.redirectUri, client_id: config.clientId, code_verifier: session.verifier };
  if (provider === 'google') body.client_secret = config.clientSecret;
  const tokens = await tokenRequest(config, body, fetchImpl);
  if (provider === 'openai') return { ...openAIClaims(tokens.access_token), accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, expiresAt: openAIClaims(tokens.access_token).expiresAt || Date.now() + tokens.expires_in * 1000 };
  const user = await fetchImpl(config.userInfoUrl, { signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${tokens.access_token}` } });
  const email = (await oauthJson(user, 'Google account profile')).email;
  const projectId = await discoverProjectId(tokens.access_token);
  return { email, projectId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
}
export async function refreshOAuth(account, fetchImpl = fetch) {
  const config = oauthConfigs[account.provider]; if (!config || !account.refreshToken) throw Object.assign(new Error('Account cannot be refreshed'), { status: 400 });
  const body = { grant_type: 'refresh_token', refresh_token: account.provider === 'google' ? account.refreshToken.split('|')[0] : account.refreshToken, client_id: config.clientId }; if (account.provider === 'google') body.client_secret = config.clientSecret;
  const tokens = await tokenRequest(config, body, fetchImpl);
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || account.refreshToken, idToken: tokens.id_token || account.idToken, expiresAt: Date.now() + tokens.expires_in * 1000 };
}
const refreshes = new Map();
export async function validAccessToken(store, account, fetchImpl = fetch) {
  if (account.accessToken && account.expiresAt > Date.now() + 60_000) return account.accessToken;
  if (!refreshes.has(account.id)) refreshes.set(account.id, refreshOAuth(account, fetchImpl).then(tokens => { store.upsert('accounts', { ...account, ...tokens }); return tokens.accessToken; }).finally(() => refreshes.delete(account.id)));
  return refreshes.get(account.id);
}
