import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/storage/store.js';
import { createDshIntegration } from '../src/api/integrations.js';
import {
  putCachedEndpointModels, getCachedEndpointModels, lookupCachedLimits, dropCachedEndpoint
} from '../src/storage/endpoint-cache.js';

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

test('endpoint cache helpers work in-memory (stores without dataDir)', () => {
  const store = memory();
  assert.equal(getCachedEndpointModels(store, 'ep1'), null);
  putCachedEndpointModels(store, 'ep1', [{ id: 'openai/gpt-4o', contextWindow: 200000, maxTokens: 16000 }]);
  const cached = getCachedEndpointModels(store, 'ep1');
  assert.equal(cached.models.length, 1);
  assert.equal(cached.models[0].contextWindow, 200000);
  assert.ok(cached.fetchedAt);
  assert.deepEqual(lookupCachedLimits(store, 'ep1', { upstreamId: 'openai/gpt-4o' }), { contextWindow: 200000, maxTokens: 16000 });
  assert.equal(lookupCachedLimits(store, 'ep1', { upstreamId: 'unknown' }), null);
  dropCachedEndpoint(store, 'ep1');
  assert.equal(getCachedEndpointModels(store, 'ep1'), null);
});

test('discover caches limits to JSON; import fills from cache; DSH reads stored values', async t => {
  const upstream = await listen(t, (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-4o', context_length: 200000, top_provider: { max_completion_tokens: 16000 } }, { id: 'plain-model' }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  const dir = temp(t), store = new Store({ dataDir: dir, keyFile: path.join(dir, 'key') });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const saved = await post('/admin/api/endpoints', { name: 'OpenRouter', baseUrl: `${upstream}/v1`, allowPrivate: true });
  assert.equal(saved.status, 201);
  const endpoint = await saved.json();

  // Fetch time: detection runs, values cached to endpoint-models-cache.json.
  const discovery = await (await post(`/admin/api/endpoints/${endpoint.id}/discover`, {})).json();
  const gpt = discovery.models.find(m => m.id === 'openai/gpt-4o');
  assert.equal(gpt.contextWindow, 200000);
  assert.equal(gpt.maxTokens, 16000);
  assert.ok(discovery.fetchedAt);
  assert.ok(fs.existsSync(path.join(dir, 'endpoint-models-cache.json')));

  // Read back without network (cache route).
  const cache = await (await fetch(`${base}/admin/api/endpoints/${endpoint.id}/discover/cache`)).json();
  assert.equal(cache.models.find(m => m.id === 'openai/gpt-4o').contextWindow, 200000);
  assert.equal(cache.fetchedAt, discovery.fetchedAt);

  // Import to KV WITHOUT limits: backend fills them from the JSON cache.
  const route = `/admin/api/endpoints/${endpoint.id}/models`;
  const imported = await (await post(route, { publicId: 'openai/gpt-4o', upstreamId: 'openai/gpt-4o' })).json();
  assert.equal(imported.contextWindow, 200000);
  assert.equal(imported.maxTokens, 16000);

  // DSH plan is sync and uses stored values (no live fetch).
  const dsh = createDshIntegration(store, { file: path.join(dir, 'dsh.yaml') });
  const plan = dsh.plan();
  const entry = plan.changes[0].models.find(m => m.id === 'openai/gpt-4o');
  assert.equal(entry.contextWindow, 200000);
  assert.equal(entry.maxTokens, 16000);

  // Reopen: a fresh Store on the same dataDir still serves the cache file.
  const reopened = new Store({ dataDir: dir, keyFile: path.join(dir, 'key') });
  const cache2 = getCachedEndpointModels(reopened, endpoint.id);
  assert.equal(cache2.models.find(m => m.id === 'openai/gpt-4o').maxTokens, 16000);
});

test('endpoint without upstream limits falls back to 128K context / 32K output', async t => {
  const upstream = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'llama3.2:latest' }] }));
  });
  const dir = temp(t), store = new Store({ dataDir: dir, keyFile: path.join(dir, 'key') });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const endpoint = await (await post('/admin/api/endpoints', { name: 'Ollama', baseUrl: `${upstream}/v1`, allowPrivate: true })).json();
  const discovery = await (await post(`/admin/api/endpoints/${endpoint.id}/discover`, {})).json();
  assert.equal(discovery.models[0].contextWindow, undefined);
  await post(`/admin/api/endpoints/${endpoint.id}/models`, { publicId: 'llama3.2:latest', upstreamId: 'llama3.2:latest' });

  const plan = createDshIntegration(store, { file: path.join(dir, 'dsh.yaml') }).plan();
  const entry = plan.changes[0].models.find(m => m.id === 'llama3.2:latest');
  assert.equal(entry.contextWindow, 131072);
  assert.equal(entry.maxTokens, 32768);
});

test('deleting an endpoint drops its cache entry', async t => {
  const upstream = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'm', context_length: 64000 }] }));
  });
  const dir = temp(t), store = new Store({ dataDir: dir, keyFile: path.join(dir, 'key') });
  const base = await listen(t, createApp(store));
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const endpoint = await (await post('/admin/api/endpoints', { name: 'Tmp', baseUrl: `${upstream}/v1`, allowPrivate: true })).json();
  await post(`/admin/api/endpoints/${endpoint.id}/discover`, {});
  assert.ok(getCachedEndpointModels(store, endpoint.id));
  const del = await fetch(`${base}/admin/api/endpoints/${endpoint.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal(getCachedEndpointModels(store, endpoint.id), null);
});
