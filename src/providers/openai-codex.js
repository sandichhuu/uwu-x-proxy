import { validAccessToken } from '../auth/oauth.js';
const BASE = 'https://chatgpt.com/backend-api';
const headers = (token, account) => ({ authorization: `Bearer ${token}`, 'chatgpt-account-id': account.accountId, accept: 'application/json' });

// Discovery returns exactly what the upstream account exposes; there is no
// hardcoded allowlist, so renamed/new models (and plan-specific ones) appear
// automatically. The account's supported reasoning levels are preserved.
export async function discoverOpenAI(store, account) {
  try {
    const token = await validAccessToken(store, account);
    const response = await fetch(`${BASE}/codex/models?client_version=0.100.0`, {
      headers: headers(token, account),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.models || [])
      .filter(x => x.supported_in_api !== false && x.slug)
      .map(x => ({
        id: x.slug,
        name: x.display_name || x.slug,
        upstreamId: x.slug,
        supported: (x.supported_reasoning_levels || []).map(l => typeof l === 'string' ? l : l?.effort).filter(Boolean),
        default: x.default_reasoning_level || 'medium',
        description: x.description || ''
      }));
  } catch (err) {
    console.warn('OpenAI upstream model discovery failed:', err.message);
    return [];
  }
}
export async function quotaOpenAI(store, account) {
  const token = await validAccessToken(store, account), response = await fetch(`${BASE}/wham/usage`, { headers: headers(token, account) });
  if (!response.ok) throw Object.assign(new Error(`OpenAI quota returned HTTP ${response.status}`), { status: response.status });
  const quota = await response.json(); store.upsert('accounts', { ...account, quota, quotaCheckedAt: new Date().toISOString() }); return quota;
}
export async function executeCodex(store, account, payload, signal) {
  const token = await validAccessToken(store, account); return fetch(`${BASE}/codex/responses`, { method: 'POST', headers: { ...headers(token, account), 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ ...payload, store: false, stream: true }), signal });
}
