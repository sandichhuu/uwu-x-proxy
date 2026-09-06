import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('root and /v1 inference routes behave identically', async t => {
  const upstream = await listen(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    assert.equal(JSON.parse(text).model, 'raw');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'chat-1', model: 'raw', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} }));
  });
  const store = memory();
  store.data.endpoints.push({ id: 'e', baseUrl: `${upstream}/v1`, allowPrivate: true, protocol: 'openai' });
  store.data.models.push({ id: 'public', endpointId: 'e', upstreamId: 'raw' });
  const base = await listen(t, createApp(store));
  const get = async route => {
    const res = await fetch(base + route);
    return { status: res.status, body: await res.text() };
  };
  const post = async (route, body, anthropic = false) => {
    const res = await fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}) },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.text() };
  };

  const plainModels = await get('/models'), v1Models = await get('/v1/models');
  assert.equal(plainModels.status, 200);
  assert.deepEqual(JSON.parse(plainModels.body), JSON.parse(v1Models.body));

  const chatBody = { model: 'public', messages: [{ role: 'user', content: 'hi' }] };
  const plainChat = await post('/chat/completions', chatBody), v1Chat = await post('/v1/chat/completions', chatBody);
  assert.equal(plainChat.status, 200);
  assert.deepEqual(JSON.parse(plainChat.body), JSON.parse(v1Chat.body));

  const msgBody = { model: 'public', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
  const plainMsg = await post('/messages', msgBody, true), v1Msg = await post('/v1/messages', msgBody, true);
  assert.equal(plainMsg.status, 200);
  assert.deepEqual(JSON.parse(plainMsg.body), JSON.parse(v1Msg.body));

  const plainCount = await post('/messages/count_tokens', msgBody, true), v1Count = await post('/v1/messages/count_tokens', msgBody, true);
  assert.equal(plainCount.status, v1Count.status);
});
