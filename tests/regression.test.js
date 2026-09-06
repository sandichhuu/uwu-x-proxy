import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import YAML from 'yaml';
import { resolveModel } from '../src/core/models.js';
import { effortFrom, anthropicToOpenAI, openAIToAnthropic } from '../src/core/protocols.js';
import { createDshIntegration, inspect } from '../src/api/integrations.js';
import { Store } from '../src/storage/store.js';
import { assertSafeUrl, safeFetch, isPrivateAddress } from '../src/security/network.js';
import { accountModelCards, calculateQuotaPercent } from '../public/model-dict.js';
process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/index.js');
function memory() {
  return {
    data: { settings: { proxyKey: 'proxy' }, endpoints: [], models: [], routes: [], accounts: [], requests: [] },
    list(k) { return this.data[k] || []; },
    record(r) { this.data.requests.push(r); },
    upsert(k, v) {
      const all = this.list(k), i = all.findIndex(x => x.id === v.id);
      i < 0 ? all.push(v) : all[i] = { ...all[i], ...v };
      this.data[k] = all;
      return v;
    },
    remove(k, id) {
      const before = this.data[k] || [];
      this.data[k] = before.filter(x => x.id !== id);
      return before.length !== this.data[k].length;
    }
  };
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwu-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test('effort defaults resolve variants and reject unsupported/conflicting values', () => {
  const store = memory();
  store.data.endpoints.push({ id: 'e' });
  store.data.models.push({ id: 'public', endpointId: 'e', upstreamId: 'wrong', effort: { mode: 'variant', default: 'medium', supported: ['medium'], variants: { medium: 'raw-medium' } } });
  assert.equal(resolveModel(store, 'public').upstreamId, 'raw-medium');
  assert.throws(() => resolveModel(store, 'public', 'high'), { status: 400 });
  assert.throws(() => effortFrom({ reasoning_effort: 'low', reasoning: { effort: 'high' } }), { status: 400 });
  store.data.models[0].effort = { mode: 'forward', supported: ['high'], default: 'high' };
  assert.equal(resolveModel(store, 'public', 'low').effort, 'low');
  assert.equal(resolveModel(store, 'public').effort, undefined);
  store.data.endpoints[0].enabled = false;
  assert.throws(() => resolveModel(store, 'public', 'high'), { status: 503 });
});
test('Anthropic tool calls and results survive conversion; images fail explicitly', () => {
  const body = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'weather', input: { city: 'Hanoi' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'sunny' }] }], tools: [{ name: 'weather', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } };
  const result = anthropicToOpenAI(body, { upstreamId: 'raw' });
  assert.equal(result.messages[0].tool_calls[0].id, 'call1');
  assert.equal(result.messages[1].tool_call_id, 'call1');
  assert.equal(result.tool_choice, 'required');
  const reply = openAIToAnthropic({ choices: [{ message: { tool_calls: result.messages[0].tool_calls }, finish_reason: 'tool_calls' }] }, 'public');
  assert.equal(reply.stop_reason, 'tool_use'); assert.deepEqual(reply.content[0].input, { city: 'Hanoi' });
  assert.throws(() => anthropicToOpenAI({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }, {}), { status: 400 });
});
test('DSH validates every parent shape and x-proxy shape', () => {
  for (const doc of [null, [], 'x', { 'llm-pi-ai': null }, { 'llm-pi-ai': { providers: null } }, { 'llm-pi-ai': { providers: { 'x-proxy': [] } } }, { 'llm-pi-ai': { providers: { 'x-proxy': 'x' } } }]) assert.equal(inspect(doc).state, 'invalid');
});
test('DSH preview, backup, comment preservation, Codex-only mapping and idempotence', t => {
  const file = path.join(temp(t), 'settings.yaml'), store = memory();
  const original = '# keep comment\nother: true\nllm-pi-ai:\n  providers:\n    codex: {custom: yes}\n';
  fs.writeFileSync(file, original);
  store.data.models.push({ id: 'codex-model', provider: 'openai-codex' }, { id: 'custom', effort: { mode: 'passthrough' } });
  const dsh = createDshIntegration(store, { file });
  const plan = dsh.plan();
  assert.throws(() => dsh.install(), { status: 409 });
  assert.equal(plan.changes[0].models[0].reasoningEfforts.max, 'ultra');
  assert.equal(plan.changes[0].models[1].reasoningEfforts, undefined);
  assert.equal(dsh.install({ confirmed: true, revision: plan.revision }).changed, true);
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /# keep comment/);
  assert.equal(YAML.parse(written)['llm-pi-ai'].providers.codex.custom, 'yes');
  const backup = fs.readdirSync(path.dirname(file)).find(x => x.includes('.backup-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8'), original);
  assert.equal(dsh.install({ confirmed: true, revision: plan.revision }).changed, false);
});
test('DSH refuses stale plans, lock conflicts and YAML aliases without clobbering', t => {
  const file = path.join(temp(t), 'settings.yaml'), dsh = createDshIntegration(memory(), { file });
  const plan = dsh.plan(); fs.writeFileSync(file, 'other: changed\n');
  assert.throws(() => dsh.install({ confirmed: true, revision: plan.revision }), { status: 409 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'other: changed\n');
  fs.writeFileSync(file + '.uwu.lock', '');
  assert.throws(() => dsh.install({ confirmed: true, revision: dsh.plan().revision }), { status: 409 });
  fs.unlinkSync(file + '.uwu.lock');
  fs.writeFileSync(file, 'other: &shared {}\nllm-pi-ai: *shared\n');
  assert.throws(() => dsh.install({ confirmed: true, revision: dsh.plan().revision }), { status: 409 });
});
test('state secrets are encrypted and corrupt files fail closed', t => {
  const dir = temp(t), options = { dataDir: path.join(dir, 'data'), keyFile: path.join(dir, 'secrets', 'key') };
  const store = new Store(options);
  store.upsert('endpoints', { id: 'e', apiKey: 'secret-upstream-value' });
  const text = fs.readFileSync(store.stateFile, 'utf8');
  assert.ok(!text.includes('secret-upstream-value'));
  assert.equal(new Store(options).list('endpoints')[0].apiKey, 'secret-upstream-value');
  fs.writeFileSync(store.stateFile, '{ broken');
  assert.throws(() => new Store(options), /Cannot read state safely/);
});
test('SSRF blocks private IPv4, mapped IPv6 and redirects; explicit private opt-in works', async t => {
  for (const address of ['127.0.0.1', '169.254.169.254', '100.64.0.1', '::', '::ffff:7f00:1', 'fe80::1']) assert.equal(isPrivateAddress(address), true);
  for (const url of ['http://127.0.0.1', 'http://[::ffff:127.0.0.1]', 'http://[::1]', 'http://localhost']) await assert.rejects(assertSafeUrl(url));
  const base = await listen(t, (_, res) => { res.writeHead(302, { location: 'http://169.254.169.254' }); res.end(); });
  await assert.rejects(safeFetch(base, { allowPrivate: true }), /redirects/);
});
test('UI/admin are isolated from inference auth; CORS rejects foreign origins', async t => {
  const store = memory(), base = await listen(t, createApp(store, { file: path.join(temp(t), 'dsh.yaml') }));
  assert.equal((await fetch(base + '/admin/')).status, 200);
  assert.equal((await fetch(base + '/admin/api/health', { headers: { authorization: 'Bearer admin' } })).status, 200);
  assert.equal((await fetch(base + '/models')).status, 401);
  assert.equal((await fetch(base + '/admin/api/health', { headers: { authorization: 'Bearer proxy' } })).status, 200);
  assert.equal((await fetch(base + '/admin/api/health', { headers: { origin: 'https://evil.example', authorization: 'Bearer admin' } })).status, 403);
});
test('aliases, native Responses route and effort forwarding', async t => {
  const seen = [], upstream = await listen(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    seen.push({ url: req.url, body: JSON.parse(text) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/responses' ? { id: 'resp', object: 'response', model: 'raw', output: [] } : { id: 'chat', model: 'raw', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }));
  });
  const store = memory(); store.data.endpoints.push({ id: 'e', baseUrl: upstream + '/v1', allowPrivate: true, protocol: 'openai' });
  store.data.models.push({ id: 'public', endpointId: 'e', upstreamId: 'raw', effort: { mode: 'passthrough', supported: ['high'], default: 'high' } });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { authorization: 'Bearer proxy', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const prefix of ['', '/v1']) {
    const res = await post(prefix + '/responses', { model: 'public', input: 'hi' });
    assert.equal(res.status, 200); assert.equal((await res.json()).object, 'response');
    assert.equal(seen.at(-1).url, '/v1/responses'); assert.equal(seen.at(-1).body.reasoning, undefined);
    const chat = await post(prefix + '/chat/completions', { model: 'public', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal((await chat.json()).model, 'public');
  }
});
test('SSE preserves split UTF-8, rewrites public IDs and emits DONE', async t => {
  const upstream = await listen(t, (_, res) => {
    res.setHeader('content-type', 'text/event-stream');
    const data = Buffer.from('data: {"model":"raw","choices":[{"delta":{"content":"ChÃƒÂ o"}}]}\r\n\r\ndata: [DONE]\n\n');
    const index = data.indexOf(Buffer.from('ÃƒÂ ')) + 1;
    res.write(data.subarray(0, index)); setTimeout(() => res.end(data.subarray(index)), 10);
  });
  const store = memory(); store.data.endpoints.push({ id: 'e', baseUrl: upstream, allowPrivate: true }); store.data.models.push({ id: 'public', endpointId: 'e', upstreamId: 'raw' });
  const base = await listen(t, createApp(store));
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer proxy', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'public', messages: [{ role: 'user', content: 'hi' }], stream: true }) });
  const text = await response.text(); assert.match(text, /ChÃƒÂ o/); assert.match(text, /"model":"public"/); assert.match(text, /\[DONE\]/);
});

test('OpenAI streaming is converted to valid Anthropic text, tool and usage events', async t => {
  let requestBody;
  const upstream = await listen(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requestBody = JSON.parse(text);
    res.setHeader('content-type', 'text/event-stream');
    const frames = [
      { id: 'chat1', model: 'raw', choices: [{ delta: { content: 'Xin ' } }] },
      { choices: [{ delta: { content: 'chÃƒÂ o' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'weather', arguments: '{"city":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Hanoi"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } }
    ];
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const store = memory();
  store.data.endpoints.push({ id: 'e', baseUrl: upstream, allowPrivate: true, protocol: 'openai' });
  store.data.models.push({ id: 'public', endpointId: 'e', upstreamId: 'raw' });
  const base = await listen(t, createApp(store));
  const response = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'proxy', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'public', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }], stream: true }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(requestBody.model, 'raw'); assert.equal(requestBody.stream, true);
  const output = await response.text();
  assert.match(output, /event: message_start/); assert.match(output, /"model":"public"/);
  assert.match(output, /event: content_block_start/); assert.match(output, /Xin /); assert.match(output, /chÃƒÂ o/);
  assert.match(output, /"type":"tool_use"/); assert.match(output, /"id":"call1"/);
  assert.match(output, /input_json_delta/); assert.match(output, /event: content_block_stop/);
  assert.match(output, /"stop_reason":"tool_use"/); assert.match(output, /"output_tokens":4/);
  assert.match(output, /event: message_stop/); assert.doesNotMatch(output, /\[DONE\]/);
});
test('native Anthropic uses x-api-key and upstream timeout returns 504', async t => {
  let seen;
  const upstream = await listen(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    seen = { url: req.url, headers: req.headers, body: JSON.parse(text) };
    if (seen.body.model === 'slow') return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg', type: 'message', model: 'raw', content: [{ type: 'text', text: 'ok' }] }));
  });
  const store = memory();
  store.data.endpoints.push({ id: 'e', baseUrl: upstream, protocol: 'anthropic', apiKey: 'upstream-secret', allowPrivate: true, timeoutMs: 100 });
  store.data.models.push({ id: 'public', upstreamId: 'raw', endpointId: 'e' }, { id: 'slow', upstreamId: 'slow', endpointId: 'e' });
  const base = await listen(t, createApp(store));
  const post = model => fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'proxy', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) });
  const response = await post('public');
  assert.equal((await response.json()).model, 'public');
  assert.equal(seen.url, '/messages');
  assert.equal(seen.headers['x-api-key'], 'upstream-secret');
  assert.equal(seen.headers.authorization, undefined);
  assert.equal((await post('slow')).status, 504);
});
test('administration requires loopback but no UWU_ADMIN_KEY', async t => {
  const store = memory();
  const base = await listen(t, createApp(store));
  assert.equal((await fetch(base + '/admin/api/health')).status, 200);
});

test('dashboard assets and chart API are served locally', async t => {
  const store = memory();
  store.data.requests.push({ at: new Date().toISOString(), model: 'demo', status: 200, tokens: 8 });
  const base = await listen(t, createApp(store));
  for (const asset of ['index.html', 'app.js', 'styles.css', 'charts.js', 'endpoints.js', 'model-dict.js']) {
    const response = await fetch(`${base}/admin/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.ok((await response.text()).length > 0);
  }
  const response = await fetch(`${base}/admin/api/analytics?range=7d`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.series.length, 7);
  assert.deepEqual(data.distribution, [{ model: 'demo', requests: 1 }]);
});

test('OpenAI-compatible local endpoint discovery, model import and inference work end to end', async t => {
  const upstream = await listen(t, async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'llama3.2:latest' }] })); }
    assert.equal(req.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).model, 'llama3.2:latest');
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'chat-1', choices: [{ message: { role: 'assistant', content: 'Hello from Ollama' }, finish_reason: 'stop' }] }));
  });
  const dir = temp(t), store = new Store({ dataDir: dir, keyFile: path.join(dir, 'key') });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/admin/api/endpoints', { name: 'Ollama', baseUrl: `${upstream}/v1` })).status, 400);
  const saved = await post('/admin/api/endpoints', { name: 'Ollama', baseUrl: `${upstream}/v1`, allowPrivate: true }); assert.equal(saved.status, 201);
  const endpoint = await saved.json(); assert.equal(endpoint.apiKey, undefined);
  const discovery = await (await post(`/admin/api/endpoints/${endpoint.id}/discover`, {})).json(); assert.equal(discovery.models[0].id, 'llama3.2:latest');
  const route = `/admin/api/endpoints/${endpoint.id}/models`, mapping = { publicId: 'ollama/llama', upstreamId: 'llama3.2:latest' };
  assert.equal((await post(route, mapping)).status, 201); assert.equal((await post(route, mapping)).status, 200);
  assert.equal((await post(route, { ...mapping, upstreamId: 'other' })).status, 409);
  assert.equal((await post(route, { publicId: '', upstreamId: '' })).status, 400);
  const models = await (await fetch(`${base}/v1/models`)).json(); assert.ok(models.data.some(m => m.id === mapping.publicId));
  const reply = await post('/v1/chat/completions', { model: mapping.publicId, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(reply.status, 200); assert.equal((await reply.json()).choices[0].message.content, 'Hello from Ollama');
});

test('admin unknown routes return JSON, and manual OAuth endpoints share callbackInput contract', async t => {
  const base = await listen(t, createApp(memory()));
  const missing = await fetch(`${base}/admin/api/not-a-route`);
  assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type'), /json/); assert.match((await missing.json()).error.message, /Unknown admin API route/);
  const request = (action, body) => fetch(`${base}/admin/api/accounts/google/oauth/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await request('start', { mode: 'manual' }); assert.equal(response.status, 200);
  const flow = await response.json(); assert.equal(flow.mode, 'manual'); assert.match(flow.authorizationUrl, /^https:\/\/accounts.google.com/);
  const invalid = await request('complete', { state: flow.state, callbackInput: 'bad' }); assert.equal(invalid.status, 400);
  const cancel = await request('cancel', { state: flow.state }); assert.equal((await cancel.json()).status, 'cancelled');
});

test('calculateQuotaPercent computes correct remaining usable percentage for Google and Codex', () => {
  // Codex / OpenAI
  assert.equal(calculateQuotaPercent(null), null);
  assert.equal(calculateQuotaPercent({}), null);
  assert.equal(calculateQuotaPercent({ provider: 'openai', quota: { rate_limit: { limit_reached: true, primary_window: { used_percent: 10 } } } }), 0);
  assert.equal(calculateQuotaPercent({ provider: 'openai', quota: { rate_limit: { primary_window: { used_percent: 15 } } } }), 85);
  assert.equal(calculateQuotaPercent({ provider: 'openai', quota: { remaining: 42 } }), 42);
  assert.equal(calculateQuotaPercent({ provider: 'openai', quota: { percentage: 30 } }), 70);
  assert.equal(calculateQuotaPercent({ provider: 'openai', quota: { used_percent: 25 } }), 75);

  // Google Antigravity
  assert.equal(calculateQuotaPercent({ provider: 'google', quota: { remainingFraction: 0.85 } }), 85);
  assert.equal(calculateQuotaPercent({ provider: 'google', quota: { 'gemini-2.5-flash': { remainingFraction: 1.0 }, 'claude-3-5-sonnet': { remainingFraction: 0.65 } } }), 65);
  assert.equal(calculateQuotaPercent({ provider: 'google', quota: { 'gemini-2.5-flash': { remainingFraction: 0.4 } } }), 40);
  assert.equal(calculateQuotaPercent({ provider: 'google', quota: { 'gemini-2.5-flash': { resetTime: '2026-09-06T12:00:00Z', remainingFraction: null } } }), 0);
  assert.equal(calculateQuotaPercent({ provider: 'google', quota: {} }), null);
});

test('account enable/disable toggle and account deletion work end to end', async t => {
  const store = memory();
  store.data.accounts.push({ id: 'acc_1', provider: 'google', email: 'user@example.com', enabled: true });
  const base = await listen(t, createApp(store));

  // Toggle account to disabled
  const patchRes = await fetch(`${base}/admin/api/accounts/google/acc_1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(patchRes.status, 200);
  assert.equal((await patchRes.json()).enabled, false);
  assert.equal(store.data.accounts[0].enabled, false);

  // Toggle account back to enabled
  const patchRes2 = await fetch(`${base}/admin/api/accounts/google/acc_1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(patchRes2.status, 200);
  assert.equal((await patchRes2.json()).enabled, true);
  assert.equal(store.data.accounts[0].enabled, true);

  // Delete account
  const delRes = await fetch(`${base}/admin/api/accounts/google/acc_1`, { method: 'DELETE' });
  assert.equal(delRes.status, 204);
  assert.equal(store.data.accounts.length, 0);

  // Deleting again returns 404
  const delRes2 = await fetch(`${base}/admin/api/accounts/google/acc_1`, { method: 'DELETE' });
  assert.equal(delRes2.status, 404);
});

test('multiple endpoints management: adding records, toggling enabled, deleting endpoints', async t => {
  const dir = temp(t), store = new Store({ dataDir: dir, keyFile: path.join(dir, 'key') });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Add endpoint 1
  const ep1Res = await post('/admin/api/endpoints', { name: 'Ollama Remote', baseUrl: 'https://example.com/v1', allowPrivate: false });
  assert.equal(ep1Res.status, 201);
  const ep1 = await ep1Res.json();
  assert.equal(ep1.name, 'Ollama Remote');

  // Add endpoint 2 (multiple endpoints support)
  const ep2Res = await post('/admin/api/endpoints', { name: 'Local vLLM', baseUrl: 'https://example.org/v1', allowPrivate: false });
  assert.equal(ep2Res.status, 201);
  const ep2 = await ep2Res.json();
  assert.equal(ep2.name, 'Local vLLM');

  // Check endpoint list
  const listRes = await fetch(`${base}/admin/api/endpoints`);
  const list = await listRes.json();
  assert.equal(list.length, 2);

  // Toggle endpoint 1 to disabled
  const patchRes = await fetch(`${base}/admin/api/endpoints/${ep1.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(patchRes.status, 200);
  assert.equal((await patchRes.json()).enabled, false);

  // Delete endpoint 2
  const delRes = await fetch(`${base}/admin/api/endpoints/${ep2.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 204);
  const remaining = await (await fetch(`${base}/admin/api/endpoints`)).json();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, ep1.id);
});

test('model dictionary mapping toggle: map model (toggle ON) and unmap model (toggle OFF)', async t => {
  const store = memory();
  store.data.endpoints.push({ id: 'ep_1', name: 'Endpoint 1', protocol: 'openai', enabled: true });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Map model for account (toggle ON)
  const mapAccRes = await post('/admin/api/models', {
    id: 'my-gemini',
    upstreamId: 'gemini-2.5-flash',
    provider: 'google',
    enabled: true
  });
  assert.equal(mapAccRes.status, 201);
  assert.equal(store.data.models.length, 1);
  assert.equal(store.data.models[0].id, 'my-gemini');

  // Unmap model for account (toggle OFF)
  const unmapAccRes = await fetch(`${base}/admin/api/models/my-gemini`, { method: 'DELETE' });
  assert.equal(unmapAccRes.status, 204);
  assert.equal(store.data.models.length, 0);

  // Map model for endpoint (toggle ON)
  const mapEpRes = await post('/admin/api/endpoints/ep_1/models', {
    publicId: 'ep1/llama',
    upstreamId: 'llama3.2:latest'
  });
  assert.equal(mapEpRes.status, 201);
  assert.equal(store.data.models.length, 1);

  // Toggle OFF endpoint model (DELETE)
  const unmapEpRes = await fetch(`${base}/admin/api/models/ep1%2Fllama`, { method: 'DELETE' });
  assert.equal(unmapEpRes.status, 204);
  assert.equal(store.data.models.length, 0);

  // Re-mapping again (toggle ON) restores the mapping
  const reMapRes = await post('/admin/api/endpoints/ep_1/models', {
    publicId: 'ep1/llama',
    upstreamId: 'llama3.2:latest'
  });
  assert.equal(reMapRes.status, 201);
  assert.equal(store.data.models[0].enabled, true);
});

test('routing strategies: Round-Robin cycles sequentially, Smart selects account with most usage, strictly excludes disabled accounts', () => {
  const store = memory();
  // Set up 2 enabled accounts with different quotas and 1 disabled account with highest quota
  store.data.accounts.push(
    { id: 'acc_low', provider: 'google', email: 'low@gmail.com', enabled: true, quota: { remainingFraction: 0.2 } },
    { id: 'acc_high', provider: 'google', email: 'high@gmail.com', enabled: true, quota: { remainingFraction: 0.9 } },
    { id: 'acc_disabled', provider: 'google', email: 'disabled@gmail.com', enabled: false, quota: { remainingFraction: 1.0 } }
  );

  // Model with default/Round-Robin strategy
  store.data.models.push({
    id: 'gemini-rr',
    upstreamId: 'gemini-2.5-flash',
    provider: 'google',
    strategy: 'round-robin',
    enabled: true
  });

  // Under round-robin, sequential requests cycle between enabled accounts (acc_low, acc_high) and never acc_disabled
  const pick1 = resolveModel(store, 'gemini-rr');
  const pick2 = resolveModel(store, 'gemini-rr');
  const pick3 = resolveModel(store, 'gemini-rr');
  assert.notEqual(pick1.account.id, 'acc_disabled');
  assert.notEqual(pick2.account.id, 'acc_disabled');
  assert.notEqual(pick3.account.id, 'acc_disabled');
  assert.equal(pick1.account.id, 'acc_high');
  assert.equal(pick2.account.id, 'acc_low');
  assert.equal(pick3.account.id, 'acc_high');

  // Model with Smart strategy
  store.data.models.push({
    id: 'gemini-smart',
    upstreamId: 'gemini-2.5-flash',
    provider: 'google',
    strategy: 'smart',
    enabled: true
  });

  // Under Smart, it chooses acc_high because 90% > 20%, and never acc_disabled even though acc_disabled had 100%
  for (let i = 0; i < 5; i++) {
    const smartPick = resolveModel(store, 'gemini-smart');
    assert.equal(smartPick.account.id, 'acc_high');
  }

  // If acc_high is disabled, Smart must now fall back to acc_low
  store.data.accounts[1].enabled = false;
  const fallbackPick = resolveModel(store, 'gemini-smart');
  assert.equal(fallbackPick.account.id, 'acc_low');

  // If all accounts are disabled, 503 is thrown
  store.data.accounts[0].enabled = false;
  assert.throws(() => resolveModel(store, 'gemini-smart'), { status: 503 });
});

test('PATCH /admin/api/models/:id updates execution strategy and enable/disable toggle end to end', async t => {
  const dir = temp(t), store = new Store({ dataDir: dir, keyFile: path.join(dir, 'key') });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Add an endpoint and model
  const epRes = await post('/admin/api/endpoints', { name: 'Local Ollama', baseUrl: 'https://example.com/v1', allowPrivate: false });
  const ep = await epRes.json();
  const mRes = await post('/admin/api/models', {
    id: 'my-model',
    upstreamId: 'llama3.2',
    endpointId: ep.id,
    strategy: 'round-robin',
    enabled: true
  });
  assert.equal(mRes.status, 201);
  const created = await mRes.json();
  assert.equal(created.strategy, 'round-robin');
  assert.equal(created.enabled, true);

  // Update strategy to Smart
  const patchStratRes = await fetch(`${base}/admin/api/models/my-model`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'smart' })
  });
  assert.equal(patchStratRes.status, 200);
  const updatedStrat = await patchStratRes.json();
  assert.equal(updatedStrat.strategy, 'smart');

  // Toggle model to disabled
  const patchDisableRes = await fetch(`${base}/admin/api/models/my-model`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(patchDisableRes.status, 200);
  const disabledModel = await patchDisableRes.json();
  assert.equal(disabledModel.enabled, false);

  // Disabled model is excluded from /v1/models
  const modelsRes = await (await fetch(`${base}/v1/models`)).json();
  assert.equal(modelsRes.data.some(m => m.id === 'my-model'), false);

  // Toggle model back to enabled
  const patchEnableRes = await fetch(`${base}/admin/api/models/my-model`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(patchEnableRes.status, 200);
  assert.equal((await patchEnableRes.json()).enabled, true);
  const modelsRes2 = await (await fetch(`${base}/v1/models`)).json();
  assert.equal(modelsRes2.data.some(m => m.id === 'my-model'), true);
});

test('OpenAI Codex discoverOpenAI retains only gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-6-astra', async () => {
  const store = memory();
  const acc = { id: 'acc_oai', provider: 'openai', accountId: 'acc_123', accessToken: 'mock_token' };
  store.data.accounts.push(acc);
  const { discoverOpenAI, ALLOWED_OPENAI_MODEL_IDS } = await import('../src/providers/openai-codex.js');

  const models = await discoverOpenAI(store, acc);
  assert.equal(models.length, 4, `Expected exactly 4 models, got ${models.length}`);
  const modelIds = models.map(m => m.id).sort();
  assert.deepEqual(modelIds, ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'].sort());

  const astra = models.find(m => m.id === 'gpt-6-astra');
  assert.ok(astra, 'gpt-6-astra must be present');
  assert.deepEqual(astra.supported, ['light', 'medium', 'high', 'extra_high', 'ultra']);
  assert.equal(astra.default, 'medium');

  const sol = models.find(m => m.id === 'gpt-5.6-sol');
  assert.ok(sol, 'gpt-5.6-sol must be present');

  const terra = models.find(m => m.id === 'gpt-5.6-terra');
  assert.ok(terra, 'gpt-5.6-terra must be present');

  const luna = models.find(m => m.id === 'gpt-5.6-luna');
  assert.ok(luna, 'gpt-5.6-luna must be present');
});

test('Google Antigravity discoverGoogle exposes only gemini-3.6-flash-*, gemini-3.7-flash-*, gemini-3.8-flash-*, claude-*', async () => {
  const store = memory();
  const acc = { id: 'acc_goog', provider: 'google', email: 'test@gmail.com', accessToken: 'mock_token', expiresAt: Date.now() + 3600_000, projectId: 'test-proj' };
  store.data.accounts.push(acc);
  const { discoverGoogle, isAllowedGoogleModel, FALLBACK_GOOGLE_MODELS } = await import('../src/providers/google-antigravity.js');

  const models = await discoverGoogle(store, acc);
  assert.ok(models.length >= 14, `Expected at least 14 Google models, got ${models.length}`);

  // Every returned model must strictly match the allowed pattern
  for (const m of models) {
    assert.ok(isAllowedGoogleModel(m.id), `Model ${m.id} should match allowed pattern`);
  }

  const thinkingSonnet = models.find(m => m.id === 'claude-sonnet-4-6-thinking');
  assert.ok(thinkingSonnet, 'claude-sonnet-4-6-thinking must be exposed');
  assert.equal(thinkingSonnet.upstreamId, 'claude-sonnet-4-6');

  const flash38 = models.find(m => m.id === 'gemini-3.8-flash-high');
  assert.ok(flash38, 'gemini-3.8-flash-high must be present');

  const flash37 = models.find(m => m.id === 'gemini-3.7-flash-medium');
  assert.ok(flash37, 'gemini-3.7-flash-medium must be present');

  const flash36 = models.find(m => m.id === 'gemini-3.6-flash-low');
  assert.ok(flash36, 'gemini-3.6-flash-low must be present');

  // Verify non-matching models are strictly excluded
  assert.equal(models.some(m => m.id === 'gemini-2.5-flash'), false);
  assert.equal(models.some(m => m.id === 'gemini-pro-agent'), false);
  assert.equal(models.some(m => m.id === 'gpt-oss-120b-medium'), false);
});

test('forward mode preserves reasoning effort exactly without aliases, validation, or defaults', () => {
  const store = memory();
  store.data.accounts.push({ id: 'acc_oai', provider: 'openai', enabled: true });
  store.data.models.push({
    id: 'gpt-6-astra',
    upstreamId: 'gpt-6-astra',
    provider: 'openai',
    effort: { mode: 'forward', supported: ['light'], default: 'medium' },
    enabled: true
  });

  for (const effort of ['light', 'low', 'minimal', 'xhigh', 'max', 'vendor-future-level']) {
    assert.equal(resolveModel(store, 'gpt-6-astra', effort).effort, effort);
  }
  assert.equal(resolveModel(store, 'gpt-6-astra').effort, undefined);
});

test('account cards use one-to-one names and never group Google effort variants', () => {
  const cards = accountModelCards([
    { id: 'gemini-3.8-flash-medium-low' },
    { id: 'gemini-3.8-flash-medium' },
    { id: 'gemini-3.8-flash-high' },
    { id: 'gemini-3.8-flash-tiered' }
  ], 'google');
  assert.deepEqual(cards.map(x => [x.id, x.upstreamId]), [
    ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium-low'],
    ['gemini-3.8-flash-medium', 'gemini-3.8-flash-medium'],
    ['gemini-3.8-flash-high', 'gemini-3.8-flash-high'],
    ['gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered']
  ]);
  assert.ok(cards.every(x => x.effort.mode === 'forward'));
});

test('Add Account popup modal frontend assets and styling contracts', async t => {
  const oauthJs = fs.readFileSync(path.join(process.cwd(), 'public', 'oauth.js'), 'utf8');
  assert.match(oauthJs, /export function openAddAccountModal/);
  assert.match(oauthJs, /export function oauthPanel/);
  assert.match(oauthJs, /modal-backdrop/);
  assert.match(oauthJs, /modal-box/);

  const stylesCss = fs.readFileSync(path.join(process.cwd(), 'public', 'styles.css'), 'utf8');
  assert.match(stylesCss, /\.modal-backdrop/);
  assert.match(stylesCss, /\.modal-box/);
  assert.match(stylesCss, /\.oauth-primary-btn/);
  assert.match(stylesCss, /\.spinner/);

  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  assert.match(appJs, /openAddAccountModal/);
  assert.match(appJs, /\+ Add Account/);
});

test('autoFetch is disabled so refresh does not automatically add models, quota updates in-place', async t => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  // autoFetch must be false so refreshing/viewing tab does not automatically add models
  assert.match(appJs, /autoFetch:\s*false/);
  assert.doesNotMatch(appJs, /autoFetch:\s*true/);

  // Quota background update must update badge in-place, not re-clicking the tab button
  assert.match(appJs, /updateBadge\(\);/);
  assert.doesNotMatch(appJs, /api\(`accounts\/\$\{provider\}\/\$\{encodeURIComponent\(r\.id\)\}\/quota`\)\s*\.then\([^)]*button\.click\(\)/);

  const modelDictJs = fs.readFileSync(path.join(process.cwd(), 'public', 'model-dict.js'), 'utf8');
  assert.match(modelDictJs, /autoFetch\s*=\s*false/);
});

test('fetching models clears old records and defaults to mapped, exact model names without prefixes', async t => {
  const modelDictJs = fs.readFileSync(path.join(process.cwd(), 'public', 'model-dict.js'), 'utf8');
  // Must clear old models before adding new ones
  assert.match(modelDictJs, /DELETE/);
  // Must NOT invent artificial prefixes like `${endpointId}/${pubId}`
  assert.doesNotMatch(modelDictJs, /\$\{endpointId\}\/\$\{pubId\}/);

  const endpointsJs = fs.readFileSync(path.join(process.cwd(), 'public', 'endpoints.js'), 'utf8');
  // Modal popup for model import in OpenAI-compatible tab
  assert.match(endpointsJs, /export function openImportModelsModal/);
  assert.match(endpointsJs, /openImportModelsModal/);
  assert.match(endpointsJs, /modal-model-list/);
  assert.match(endpointsJs, /modal-model-search/);
  assert.match(endpointsJs, /Select All/);
  assert.match(endpointsJs, /Deselect All/);

  const stylesCss = fs.readFileSync(path.join(process.cwd(), 'public', 'styles.css'), 'utf8');
  assert.match(stylesCss, /\.modal-model-list/);
  assert.match(stylesCss, /\.modal-model-search/);
  assert.match(stylesCss, /\.modal-model-item/);
});

test('multiple endpoints with same model name share model card and route via Round-Robin and Smart', async t => {
  const store = memory();
  store.data.endpoints.push(
    { id: 'ep_alpha', name: 'Ollama Alpha', protocol: 'openai', baseUrl: 'http://alpha.local/v1', enabled: true },
    { id: 'ep_beta', name: 'vLLM Beta', protocol: 'openai', baseUrl: 'http://beta.local/v1', enabled: true }
  );

  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // 1. Endpoint Alpha maps model "llama3.2:latest" (exact name as received)
  const res1 = await post('/admin/api/endpoints/ep_alpha/models', {
    publicId: 'llama3.2:latest',
    upstreamId: 'llama3.2:latest'
  });
  assert.equal(res1.status, 201);
  assert.equal(store.data.models.length, 1);
  assert.equal(store.data.models[0].id, 'llama3.2:latest');

  // 2. Endpoint Beta ALSO maps the exact same model name "llama3.2:latest" (multi-source)
  const res2 = await post('/admin/api/endpoints/ep_beta/models', {
    publicId: 'llama3.2:latest',
    upstreamId: 'llama3.2:latest'
  });
  // Must NOT fail with 409! Must merge ep_beta as an additional source
  assert.ok(res2.status === 201 || res2.status === 200);
  assert.equal(store.data.models.length, 1); // Shares the single public model card
  const sharedModel = store.data.models[0];
  assert.equal(sharedModel.id, 'llama3.2:latest');
  assert.ok(sharedModel.endpointIds?.includes('ep_alpha'));
  assert.ok(sharedModel.endpointIds?.includes('ep_beta'));

  // 3. Round-Robin routing between multiple endpoints with the same model name
  const pick1 = resolveModel(store, 'llama3.2:latest');
  const pick2 = resolveModel(store, 'llama3.2:latest');
  const pick3 = resolveModel(store, 'llama3.2:latest');
  assert.equal(pick1.model.id, 'llama3.2:latest');
  // It cycles across the endpoints
  const pickedEndpoints = [pick1.endpoint.id, pick2.endpoint.id, pick3.endpoint.id];
  assert.ok(pickedEndpoints.includes('ep_alpha'));
  assert.ok(pickedEndpoints.includes('ep_beta'));

  // 4. If ep_alpha is disabled, requests to llama3.2:latest route strictly to ep_beta
  store.data.endpoints[0].enabled = false;
  const fallbackPick = resolveModel(store, 'llama3.2:latest');
  assert.equal(fallbackPick.endpoint.id, 'ep_beta');

  // 5. Unmapping from ep_alpha removes ep_alpha without deleting the model for ep_beta
  const unmapRes = await fetch(`${base}/admin/api/endpoints/ep_alpha/models/llama3.2:latest`, { method: 'DELETE' });
  assert.equal(unmapRes.status, 204);
  assert.equal(store.data.models.length, 1);
  assert.equal(store.data.models[0].id, 'llama3.2:latest');
  assert.deepEqual(store.data.models[0].endpointIds, ['ep_beta']);

  // 6. Unmapping from ep_beta removes the model completely when no sources remain
  const unmapRes2 = await fetch(`${base}/admin/api/endpoints/ep_beta/models/llama3.2:latest`, { method: 'DELETE' });
  assert.equal(unmapRes2.status, 204);
  assert.equal(store.data.models.length, 0);
});

test('endpoint creation defaults to allowPrivate, Remove All cleans models, and extraneous texts are removed', async t => {
  // 1. Check endpoints.js form defaults to allowPrivate: true and does not display checkbox line
  const endpointsJs = fs.readFileSync(path.join(process.cwd(), 'public', 'endpoints.js'), 'utf8');
  assert.doesNotMatch(endpointsJs, /Allow localhost \/ private network/);
  assert.match(endpointsJs, /allowPrivate:\s*true/);

  // 2. Check Remove All button exists in model-dict.js
  const modelDictJs = fs.readFileSync(path.join(process.cwd(), 'public', 'model-dict.js'), 'utf8');
  assert.match(modelDictJs, /Remove All/);
  assert.match(modelDictJs, /All models removed/);

  // 3. Check extraneous texts are removed
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(indexHtml, /One proxy\. More possibilities\./);
  assert.doesNotMatch(indexHtml, /OpenAI \+ Anthropic compatible/);
  assert.doesNotMatch(indexHtml, /LOCAL WORKSPACE/);

  assert.doesNotMatch(endpointsJs, /Manage your API endpoints and map their models into x-proxy/);
  assert.doesNotMatch(endpointsJs, /Key-Value dictionary for/);

  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(appJs, /authorization states and model quotas/);
  assert.doesNotMatch(appJs, /Key-Value dictionary for/);

  // 4. Check that Google/OpenAI accounts fetch models of 1 account when multiple accounts exist
  assert.match(appJs, /const fetchAccount = rows\.find/);
  assert.match(appJs, /accounts\/\$\{provider\}\/\$\{encodeURIComponent\(fetchAccount\.id\)\}\/discover/);
});

test('API Routes navigation, Auto Map, variant effort mapping, and forward mode work end to end', async t => {
  // 1. Navigation & frontend contracts
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.match(indexHtml, /data-page="routes"/);
  assert.match(indexHtml, /API Routes/);

  const appJs = fs.readFileSync(path.join(process.cwd(), 'public', 'app.js'), 'utf8');
  assert.match(appJs, /import \{ routesPanel \} from '\.\/routes\.js'/);
  assert.match(appJs, /if \(name === 'routes'\)/);
  // Quota is refreshed automatically on every tab click without null check
  assert.doesNotMatch(appJs, /if\s*\(calculateQuotaPercent\(r\)\s*===\s*null\)/);
  assert.match(appJs, /Auto-refresh quota from upstream every time the tab is clicked/);
  // Accounts keep one model card per discovered model; grouping belongs to API Routes.
  assert.match(appJs, /accountModelCards\(data\.models, provider\)/);
  // Models is preview-only: no activation toggle or strategy editor in its panel.
  const modelsPanelSource = appJs.slice(appJs.indexOf('function modelsPanel'), appJs.indexOf('async function page'));
  assert.doesNotMatch(modelsPanelSource, /toggleSwitch|select\.onchange|method:\s*'PATCH'/);

  const routesJs = fs.readFileSync(path.join(process.cwd(), 'public', 'routes.js'), 'utf8');
  assert.match(routesJs, /export function routesPanel/);
  assert.match(routesJs, /Auto Map/);
  assert.match(routesJs, /\+ Add Route/);
  assert.match(routesJs, /Remove All/);
  // Selected / Manage Mapping button removed in favor of row click highlight
  assert.doesNotMatch(routesJs, /Manage Mapping/);
  assert.match(routesJs, /tr\.onclick/);
  assert.match(routesJs, /renderRoutesList/);
  assert.match(routesJs, /renderMappingPanel/);
  assert.match(routesJs, /routes\/auto-map/);

  // 2. Auto Map endpoint via app
  const store = memory();
  store.data.accounts.push(
    { id: 'google_acc', provider: 'google', email: 'test@gmail.com', enabled: true, quota: { remainingFraction: 1 } },
    { id: 'openai_acc', provider: 'openai', email: 'test@openai.com', enabled: true, quota: { remaining: 100 } }
  );
  store.data.models.push(
    { id: 'gemini-3.8-flash-low', provider: 'google', upstreamId: 'gemini-3.8-flash-medium-low', enabled: true },
    { id: 'gemini-3.8-flash-medium', provider: 'google', upstreamId: 'gemini-3.8-flash-medium', enabled: true },
    { id: 'unrelated-account-card', provider: 'google', upstreamId: 'do-not-touch', enabled: false }
  );
  const modelsBeforeAutoMap = structuredClone(store.data.models);
  const accountsBeforeAutoMap = structuredClone(store.data.accounts);
  const endpointsBeforeAutoMap = structuredClone(store.data.endpoints);
  const base = await listen(t, createApp(store));
  const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const autoMapRes = await post('/admin/api/routes/auto-map');
  assert.equal(autoMapRes.status, 200);
  const autoMapData = await autoMapRes.json();
  assert.equal(autoMapData.ok, true);
  assert.ok(autoMapData.count >= 8);
  assert.deepEqual(store.data.models, modelsBeforeAutoMap, 'Auto Map must not mutate Models/Accounts cards');
  assert.deepEqual(store.data.accounts, accountsBeforeAutoMap, 'Auto Map must not mutate Accounts');
  assert.deepEqual(store.data.endpoints, endpointsBeforeAutoMap, 'Auto Map must not mutate API Endpoints');
  assert.equal((await (await fetch(`${base}/admin/api/models`)).json()).length, modelsBeforeAutoMap.length);
  assert.equal((await (await fetch(`${base}/admin/api/routes`)).json()).length, autoMapData.count);

  // 3. Verify gemini-3.8-flash default mapping:
  // 4 models: gemini-3.8-flash-tiered, gemini-3.8-flash-low, gemini-3.8-flash-medium, gemini-3.8-flash-high
  // -> maps to 1 model gemini-3.8-flash with efforts: low, medium, high, xhigh
  const flash38 = store.data.routes.find(m => m.id === 'gemini-3.8-flash');
  assert.ok(flash38);
  assert.equal(flash38.effort.mode, 'variant');
  assert.deepEqual(flash38.effort.supported, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(flash38.effort.default, 'medium');
  assert.equal(flash38.effort.variants.low, 'gemini-3.8-flash-low');
  assert.equal(flash38.effort.variants.medium, 'gemini-3.8-flash-medium');
  assert.equal(flash38.effort.variants.high, 'gemini-3.8-flash-high');
  assert.equal(flash38.effort.variants.xhigh, 'gemini-3.8-flash-tiered');

  // 4. Test resolveModel routing for variant mode:
  // Requests with different effort levels route to the specific model variant
  assert.equal(resolveModel(store, 'gemini-3.8-flash', 'low').upstreamId, 'gemini-3.8-flash-low');
  assert.equal(resolveModel(store, 'gemini-3.8-flash', 'medium').upstreamId, 'gemini-3.8-flash-medium');
  assert.equal(resolveModel(store, 'gemini-3.8-flash', 'high').upstreamId, 'gemini-3.8-flash-high');
  assert.equal(resolveModel(store, 'gemini-3.8-flash', 'xhigh').upstreamId, 'gemini-3.8-flash-tiered');
  // Request without effort defaults to medium -> gemini-3.8-flash-medium
  assert.equal(resolveModel(store, 'gemini-3.8-flash').upstreamId, 'gemini-3.8-flash-medium');

  // 5. Test forward mode:
  // Forward mode forwards effort to the upstream provider unchanged
  const gptSol = store.data.routes.find(m => m.id === 'gpt-5.6-sol');
  assert.ok(gptSol);
  const resolvedSol = resolveModel(store, 'gpt-5.6-sol', 'high');
  assert.equal(resolvedSol.upstreamId, 'gpt-5.6-sol');
  assert.equal(resolvedSol.effort, 'high');
});




