import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

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

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); if (server.closeAllConnections) server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('Inference tab HTML and frontend script wiring', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public/index.html'), 'utf8');
  assert.match(html, /data-page="inference"/, 'index.html contains inference nav button');
  assert.match(html, /Inference<\/button>/, 'button text is Inference');

  const appJs = fs.readFileSync(path.join(process.cwd(), 'public/app.js'), 'utf8');
  assert.match(appJs, /inferencePanel/, 'app.js imports or references inferencePanel');
  assert.match(appJs, /inference:/, 'app.js contains description for inference tab');
  assert.match(appJs, /name === 'inference'/, 'app.js routes to inference tab');

  const inferenceJs = fs.readFileSync(path.join(process.cwd(), 'public/inference.js'), 'utf8');
  assert.match(inferenceJs, /export function inferencePanel/, 'inference.js exports inferencePanel');
  assert.match(inferenceJs, /inference-model-select/, 'inference.js includes model select');
  assert.match(inferenceJs, /renderMarkdown/, 'inference.js includes markdown renderer');

  const stylesCss = fs.readFileSync(path.join(process.cwd(), 'public/styles.css'), 'utf8');
  assert.match(stylesCss, /\.inference-view/, 'styles.css contains .inference-view styles');
  assert.match(stylesCss, /\.chat-topbar/, 'styles.css contains chat topbar styles');
  assert.match(stylesCss, /\.chat-bubble/, 'styles.css contains chat bubble styles');
});

test('Inference frontend correctly formats messages on first turn (no empty messages array)', () => {
  const inferenceJs = fs.readFileSync(path.join(process.cwd(), 'public/inference.js'), 'utf8');
  // Verify slice(0, -1) happens before filtering by content
  assert.match(
    inferenceJs,
    /messages[\s\S]*?\.slice\(0,\s*-1\)[\s\S]*?\.filter/,
    'slice(0, -1) must be called before filter(m => m.content) so the user message is retained on first turn'
  );
});

test('/admin/api/chat validates input and routes via admin loopback', async t => {
  const store = memory();
  const app = createApp(store);
  const base = await listen(t, app);

  // Missing body or empty messages
  const resEmpty = await fetch(base + '/admin/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(resEmpty.status, 400);

  // Unknown model
  const resBadModel = await fetch(base + '/admin/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nonexistent-model', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(resBadModel.status, 404);
});

test('/admin/api/chat end-to-end chat with mock endpoint', async t => {
  let receivedBody = null;
  const mockUpstream = await listen(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    receivedBody = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'chatcmpl-mock-1',
      object: 'chat.completion',
      created: 12345678,
      model: 'mock-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello from mock endpoint!' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
    }));
  });

  const store = memory();
  store.data.endpoints.push({ id: 'ep-test', baseUrl: mockUpstream, allowPrivate: true, protocol: 'openai', enabled: true });
  store.data.routes.push({
    id: 'test/chat-model',
    name: 'Test Chat Model',
    endpointId: 'ep-test',
    upstreamId: 'mock-gpt',
    enabled: true,
    effort: { mode: 'forward', supported: [] }
  });

  const app = createApp(store);
  const base = await listen(t, app);

  // Non-streaming chat request
  const res = await fetch(base + '/admin/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test/chat-model',
      messages: [{ role: 'user', content: 'Hello there!' }],
      stream: false
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.role, 'assistant');
  assert.equal(data.content[0].text, 'Hello from mock endpoint!');
  assert.equal(receivedBody.model, 'mock-gpt');
  assert.equal(receivedBody.messages[0].role, 'user');
  assert.equal(receivedBody.messages[0].content, 'Hello there!');
});

test('dashboard brand shows running version from package.json, injected server-side', async t => {
  const expected = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  assert.match(expected, /^\d+\.\d+\.\d+/, 'package.json carries a semver version');
  const store = memory();
  const app = createApp(store);
  const base = await listen(t, app);

  const resVersion = await fetch(base + '/admin/api/version');
  assert.equal(resVersion.status, 200);
  assert.equal((await resVersion.json()).version, expected);

  for (const route of ['/admin/', '/admin/index.html']) {
    const resHtml = await fetch(base + route);
    assert.equal(resHtml.status, 200);
    const html = await resHtml.text();
    assert.doesNotMatch(html, /__UWU_APP_VERSION__/, `${route} has no unreplaced version token`);
    assert.match(html, new RegExp(`<small id="app-version">v${expected}<\\/small>`), `${route} brand shows v${expected}`);
  }
});
