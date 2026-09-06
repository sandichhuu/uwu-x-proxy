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
export async function discoverEndpoint(endpoint) {
  const base = await assertSafeUrl(endpoint.baseUrl, { allowPrivate: endpoint.allowPrivate === true });
  const response = await safeFetch(`${base}/models`, { allowPrivate: endpoint.allowPrivate === true, headers: endpointHeaders(endpoint), signal: AbortSignal.timeout(endpoint.timeoutMs || 10000), redirect: 'error' });
  if (!response.ok) throw new Error(`Discovery failed with HTTP ${response.status}`);
  const data = await response.json();
  return (data.data || data.models || []).map(x => ({ id: x.id || x.name, capabilities: x.capabilities || {} })).filter(x => x.id);
}
export async function executeOpenAI(endpoint, request, signal, route = 'chat/completions') {
  const base = await assertSafeUrl(endpoint.baseUrl, { allowPrivate: endpoint.allowPrivate === true });
  return safeFetch(`${base}/${route}`, { allowPrivate: endpoint.allowPrivate === true, method: 'POST', headers: endpointHeaders(endpoint), body: JSON.stringify(request), signal, redirect: 'error' });
}
