import { assertSafeUrl, safeFetch } from '../security/network.js';
export function endpointHeaders(endpoint) {
  const headers = { 'content-type': 'application/json' };
  for (const [key, value] of Object.entries(endpoint.headers || {})) {
    if (!['accept', 'openai-organization', 'openai-project', 'anthropic-beta'].includes(key.toLowerCase())) throw Object.assign(new Error('Unsupported endpoint header'), { status: 400 });
    headers[key] = value;
  }
  if (endpoint.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (endpoint.apiKey) headers['x-api-key'] = endpoint.apiKey;
  } else if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  return headers;
}
function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}
function pickFirst(...values) {
  for (const v of values) {
    const n = toPositiveInt(v);
    if (n !== undefined) return n;
  }
  return undefined;
}
// Dynamic limit detection: OpenRouter returns `context_length` +
// `top_provider.max_completion_tokens`, plain OpenAI/Ollama/vLLM usually
// returns only `id`. Return detected values when present; callers fall back
// to 128K context / 32K output when undefined.
export function describeDiscoveredModel(x) {
  if (!x || typeof x !== 'object') return null;
  const id = x.id || x.name || x.slug;
  if (!id) return null;
  const contextWindow = pickFirst(
    x.contextWindow, x.windowContext, x.context_window,
    x.context_length, x.contextLength, x.max_context,
    x.top_provider?.context_length, x.topProvider?.context_length,
    x.top_provider?.contextLength, x.topProvider?.contextLength
  );
  const maxTokens = pickFirst(
    x.maxTokens, x.max_output_tokens, x.maxOutputTokens,
    x.max_completion_tokens, x.maxCompletionTokens,
    x.top_provider?.max_completion_tokens, x.topProvider?.max_completion_tokens,
    x.top_provider?.maxCompletionTokens, x.topProvider?.maxCompletionTokens,
    x.per_request_limits?.completion_tokens, x.perRequestLimits?.completion_tokens,
    x.output_limit, x.max_output
  );
  const out = { id, capabilities: x.capabilities || {} };
  if (x.name && typeof x.name === 'string' && x.name !== id) out.name = x.name;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  return out;
}
export async function discoverEndpoint(endpoint) {
  const base = await assertSafeUrl(endpoint.baseUrl, { allowPrivate: endpoint.allowPrivate === true });
  const response = await safeFetch(`${base}/models`, { allowPrivate: endpoint.allowPrivate === true, headers: endpointHeaders(endpoint), signal: AbortSignal.timeout(endpoint.timeoutMs || 10000), redirect: 'error' });
  if (!response.ok) throw new Error(`Discovery failed with HTTP ${response.status}`);
  const data = await response.json();
  return (data.data || data.models || []).map(describeDiscoveredModel).filter(Boolean);
}
export async function executeOpenAI(endpoint, request, signal, route = 'chat/completions') {
  const base = await assertSafeUrl(endpoint.baseUrl, { allowPrivate: endpoint.allowPrivate === true });
  return safeFetch(`${base}/${route}`, { allowPrivate: endpoint.allowPrivate === true, method: 'POST', headers: endpointHeaders(endpoint), body: JSON.stringify(request), signal, redirect: 'error' });
}
