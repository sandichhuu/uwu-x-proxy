import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { resolveModel } from '../src/core/models.js';
import { createDshIntegration } from '../src/api/integrations.js';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/index.js');

function memory() {
  return {
    data: { settings: { proxyKey: '' }, endpoints: [], models: [], routes: [], accounts: [], requests: [] },
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

test('auto-map adds endpoint models as forward routes without touching other registries', async t => {
  const store = memory();
  store.data.endpoints.push({ id: 'ep_ollama', name: 'Ollama', protocol: 'openai', baseUrl: 'http://ollama.local/v1', enabled: true });
  store.data.models.push(
    { id: 'llama3.2:latest', name: 'llama3.2:latest', endpointId: 'ep_ollama', endpointIds: ['ep_ollama'], upstreamId: 'llama3.2:latest', enabled: true, strategy: 'round-robin', effort: { mode: 'forward', supported: [] } },
    { id: 'my-account-model', provider: 'google', upstreamId: 'gemini-3.8-flash-medium', enabled: true }
  );
  const modelsBefore = structuredClone(store.data.models);
  const accountsBefore = structuredClone(store.data.accounts);
  const endpointsBefore = structuredClone(store.data.endpoints);
  const base = await listen(t, createApp(store));
  const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const first = await post('/admin/api/routes/auto-map');
  assert.equal(first.status, 200);
  const data = await first.json();
  assert.equal(data.count, 9 + 1);
  const epRoute = store.list('routes').find(r => r.id === 'ollama/llama3.2:latest');
  assert.ok(epRoute);
  assert.deepEqual(epRoute.effort, { mode: 'forward', supported: [] });
  assert.deepEqual(epRoute.sources, [{ type: 'endpoint', endpointId: 'ep_ollama', upstreamId: 'llama3.2:latest' }]);
  assert.ok(!store.list('routes').some(r => r.id === 'my-account-model'));
  assert.ok(!store.list('routes').some(r => r.id === 'llama3.2:latest'));
  assert.deepEqual(store.data.models, modelsBefore);
  assert.deepEqual(store.data.accounts, accountsBefore);
  assert.deepEqual(store.data.endpoints, endpointsBefore);
  assert.equal(resolveModel(store, 'ollama/llama3.2:latest').endpoint.id, 'ep_ollama');
  // Once routes exist, raw model cards are no longer requestable directly.
  assert.throws(() => resolveModel(store, 'llama3.2:latest'), /Unknown model/);
  assert.throws(() => resolveModel(store, 'my-account-model'), /Unknown model/);

  // Customized routes survive a second run; nothing is duplicated.
  store.upsert('routes', { ...epRoute, strategy: 'smart' });
  const routesBefore = structuredClone(store.list('routes'));
  const second = await post('/admin/api/routes/auto-map');
  assert.equal(second.status, 200);
  assert.deepEqual(store.list('routes'), routesBefore);
  assert.equal(store.list('routes').find(r => r.id === 'ollama/llama3.2:latest').strategy, 'smart');
});

test('auto-map renames endpoint routes after the endpoint is renamed', async t => {
  const store = memory();
  store.data.endpoints.push({ id: 'ep_ollama', name: 'Ollama', protocol: 'openai', baseUrl: 'http://ollama.local/v1', enabled: true, allowPrivate: true });
  store.data.models.push(
    { id: 'llama3.2:latest', name: 'llama3.2:latest', endpointId: 'ep_ollama', endpointIds: ['ep_ollama'], upstreamId: 'llama3.2:latest', enabled: true, strategy: 'round-robin', effort: { mode: 'forward', supported: [] } }
  );
  const base = await listen(t, createApp(store));
  const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const patch = (route, body = {}) => fetch(`${base}${route}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await post('/admin/api/routes/auto-map');
  assert.ok(store.list('routes').some(r => r.id === 'ollama/llama3.2:latest'));

  // Customize then rename the endpoint (spaces become underscores).
  store.upsert('routes', { ...store.list('routes').find(r => r.id === 'ollama/llama3.2:latest'), strategy: 'smart' });
  const rename = await patch('/admin/api/endpoints/ep_ollama', { name: 'My Server' });
  assert.equal(rename.status, 200);

  const remap = await post('/admin/api/routes/auto-map');
  assert.equal(remap.status, 200);
  const renamed = store.list('routes').find(r => r.id === 'my_server/llama3.2:latest');
  assert.ok(renamed, 'remap must create a route with the new endpoint prefix');
  assert.ok(!store.list('routes').some(r => r.id === 'ollama/llama3.2:latest'), 'stale route with the old prefix must be removed');
  assert.equal(renamed.strategy, 'smart', 'customizations survive the rename');
  assert.equal(resolveModel(store, 'my_server/llama3.2:latest').endpoint.id, 'ep_ollama');
  assert.throws(() => resolveModel(store, 'ollama/llama3.2:latest'), /Unknown model/);
});

test('raw upstream ids are not requestable once routes exist', t => {
  const store = memory();
  store.data.accounts.push({ id: 'acc', provider: 'google', enabled: true });
  // Model cards exist before any route (e.g. fetched account models).
  store.data.models.push(
    { id: 'gemini-3.8-flash-medium', provider: 'google', upstreamId: 'gemini-3.8-flash-medium', enabled: true }
  );
  // No routes yet: model cards stay requestable (backward compat / fresh setup).
  assert.equal(resolveModel(store, 'gemini-3.8-flash-medium').upstreamId, 'gemini-3.8-flash-medium');
  // A prefixed route exists: only the route id is public now.
  store.data.routes.push(
    { id: 'google/gemini-3.8-flash', provider: 'google', upstreamId: 'gemini-3.8-flash-medium', effort: { mode: 'forward', supported: [] }, enabled: true }
  );
  assert.equal(resolveModel(store, 'google/gemini-3.8-flash').upstreamId, 'gemini-3.8-flash-medium');
  assert.throws(() => resolveModel(store, 'gemini-3.8-flash-medium'), /Unknown model/);
});

test('dsh install omits reasoningEffort but keeps reasoningEfforts', t => {
  const file = path.join(temp(t), 'settings.yaml'), store = memory();
  store.data.models.push(
    { id: 'codex-model', provider: 'openai-codex' },
    { id: 'effort-model', provider: 'openai', effort: { mode: 'forward', supported: ['high'], default: 'high' } }
  );
  const plan = createDshIntegration(store, { file }).plan();
  const codex = plan.changes[0].models.find(m => m.id === 'codex-model');
  const effort = plan.changes[0].models.find(m => m.id === 'effort-model');
  assert.ok(codex.reasoningEfforts);
  assert.ok(!('reasoningEffort' in codex));
  assert.deepEqual(effort.reasoningEfforts, { minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max', max: 'ultra' });
  assert.ok(!('reasoningEffort' in effort));
});

test('routes UI falls back to low as the default effort', () => {
  const routesJs = fs.readFileSync(new URL('../public/routes.js', import.meta.url), 'utf8');
  assert.match(routesJs, /defSelect\.value = selectedRoute\.effort\?\.default \|\| 'low'/);
  assert.match(routesJs, /default: 'low'/);
});

test('endpoints table selects records by row click', () => {
  const endpointsJs = fs.readFileSync(new URL('../public/endpoints.js', import.meta.url), 'utf8');
  assert.match(endpointsJs, /tr\.onclick/);
  assert.match(endpointsJs, /Manage models for endpoint/);
  assert.doesNotMatch(endpointsJs, /Manage Models/);
});
