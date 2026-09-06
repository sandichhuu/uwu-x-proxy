import { validAccessToken } from '../auth/oauth.js';
const BASE = 'https://chatgpt.com/backend-api';
const headers = (token, account) => ({ authorization: `Bearer ${token}`, 'chatgpt-account-id': account.accountId, accept: 'application/json' });

export const ALLOWED_OPENAI_MODEL_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra'
]);

export const DISCOVERABLE_OPENAI_MODELS = Object.freeze([
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', upstreamId: 'gpt-5.6-sol', supported: ['low', 'medium', 'high'], default: 'medium', description: 'Flagship GPT-5.6 model for complex reasoning and coding' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', upstreamId: 'gpt-5.6-terra', supported: ['low', 'medium', 'high'], default: 'medium', description: 'Balanced GPT-5.6 model for everyday work' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', upstreamId: 'gpt-5.6-luna', supported: ['low', 'medium', 'high'], default: 'medium', description: 'Fast and efficient GPT-5.6 model for high-volume workloads' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', upstreamId: 'gpt-6-astra', supported: ['light', 'medium', 'high', 'extra_high', 'ultra'], default: 'medium', description: 'GPT-6 Astra with configurable Light through Ultra reasoning' }
]);

export async function discoverOpenAI(store, account) {
  let upstreamModels = [];
  try {
    const token = await validAccessToken(store, account);
    const response = await fetch(`${BASE}/codex/models?client_version=0.100.0`, {
      headers: headers(token, account),
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) {
      const data = await response.json();
      upstreamModels = (data.models || [])
        .filter(x => x.supported_in_api !== false && ALLOWED_OPENAI_MODEL_IDS.has(x.slug))
        .map(x => ({
          id: x.slug,
          name: x.display_name || x.slug,
          upstreamId: x.slug,
          supported: x.supported_reasoning_levels || [],
          default: x.default_reasoning_level || 'medium',
          description: x.description || ''
        }));
    }
  } catch (err) {
    console.warn('OpenAI upstream model discovery error, using discoverable models:', err.message);
  }

  // Merge discoverable models (only allowed models)
  const merged = [...upstreamModels];
  const knownIds = new Set(upstreamModels.map(m => m.id));

  for (const model of DISCOVERABLE_OPENAI_MODELS) {
    if (!knownIds.has(model.id) && ALLOWED_OPENAI_MODEL_IDS.has(model.id)) {
      merged.push({ ...model });
      knownIds.add(model.id);
    }
  }

  return merged;
}
export async function quotaOpenAI(store, account) {
  const token = await validAccessToken(store, account), response = await fetch(`${BASE}/wham/usage`, { headers: headers(token, account) });
  if (!response.ok) throw Object.assign(new Error(`OpenAI quota returned HTTP ${response.status}`), { status: response.status });
  const quota = await response.json(); store.upsert('accounts', { ...account, quota, quotaCheckedAt: new Date().toISOString() }); return quota;
}
export async function executeCodex(store, account, payload, signal) {
  const token = await validAccessToken(store, account); return fetch(`${BASE}/codex/responses`, { method: 'POST', headers: { ...headers(token, account), 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ ...payload, store: false, stream: true }), signal });
}
