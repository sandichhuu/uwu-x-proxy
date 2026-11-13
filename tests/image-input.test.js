import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { anthropicToOpenAI } from '../src/core/protocols.js';
import { anthropicToGemini, openAIToGemini } from '../src/providers/google-converter.js';
import { anthropicToResponses } from '../src/providers/codex-converter.js';
import { createDshIntegration } from '../src/api/integrations.js';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/index.js');

function memory() {
  return {
    data: { settings: {}, endpoints: [], models: [], routes: [], accounts: [], requests: [] },
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

test('anthropicToOpenAI converts Anthropic image blocks to OpenAI image_url parts', () => {
  const sampleBase64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAD8D+JaQAA3AA/ua1AAA=';
  const body = {
    model: 'strata/qwen3.8-flash-next-coder-iq1_m',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this webp image?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/webp',
              data: sampleBase64
            }
          }
        ]
      }
    ]
  };

  const converted = anthropicToOpenAI(body, { upstreamId: 'qwen3.8-flash-next-coder-iq1_m' });
  assert.equal(converted.model, 'qwen3.8-flash-next-coder-iq1_m');
  assert.equal(converted.messages.length, 1);
  assert.equal(converted.messages[0].role, 'user');
  assert.ok(Array.isArray(converted.messages[0].content));
  assert.equal(converted.messages[0].content.length, 2);
  assert.deepEqual(converted.messages[0].content[0], { type: 'text', text: 'what is in this webp image?' });
  assert.deepEqual(converted.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: `data:image/webp;base64,${sampleBase64}` }
  });
});

test('anthropicToOpenAI converts image in tool_result block', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_123',
            content: [
              { type: 'text', text: 'read file result' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgo='
                }
              }
            ]
          }
        ]
      }
    ]
  };

  const converted = anthropicToOpenAI(body, { upstreamId: 'raw-model' });
  assert.equal(converted.messages.length, 1);
  assert.equal(converted.messages[0].role, 'tool');
  assert.equal(converted.messages[0].tool_call_id, 'tool_123');
  assert.ok(Array.isArray(converted.messages[0].content));
  assert.deepEqual(converted.messages[0].content[0], { type: 'text', text: 'read file result' });
  assert.deepEqual(converted.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' }
  });
});

test('anthropicToGemini converts Anthropic image blocks to Gemini inlineData parts', () => {
  const request = anthropicToGemini({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/webp',
              data: 'UklGRiQ='
            }
          }
        ]
      }
    ]
  }, { upstreamId: 'gemini-3.8-flash' });

  assert.equal(request.contents.length, 1);
  assert.equal(request.contents[0].role, 'user');
  assert.equal(request.contents[0].parts.length, 2);
  assert.deepEqual(request.contents[0].parts[0], { text: 'look at this' });
  assert.deepEqual(request.contents[0].parts[1], {
    inlineData: {
      mimeType: 'image/webp',
      data: 'UklGRiQ='
    }
  });
});

test('openAIToGemini converts OpenAI image_url data URIs to Gemini inlineData parts', () => {
  const request = openAIToGemini({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }
          }
        ]
      }
    ]
  }, { upstreamId: 'gemini-3.8-flash' });

  assert.equal(request.contents.length, 1);
  assert.deepEqual(request.contents[0].parts, [
    { text: 'inspect' },
    { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } }
  ]);
});

test('anthropicToResponses converts Anthropic image blocks to Codex input_image parts', () => {
  const payload = anthropicToResponses({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'check image' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgo='
            }
          }
        ]
      }
    ]
  }, { upstreamId: 'codex-model' });

  assert.equal(payload.input.length, 1);
  assert.equal(payload.input[0].type, 'message');
  assert.deepEqual(payload.input[0].content, [
    { type: 'input_text', text: 'check image' },
    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }
  ]);
});

test('DSH integration plan outputs defaultInput and model input modalities', () => {
  const store = memory();
  store.data.routes.push({
    id: 'strata/qwen3.8-flash-next-coder-iq1_m',
    name: 'strata/qwen3.8-flash-next-coder-iq1_m',
    upstreamId: 'qwen3.8-flash-next-coder-iq1_m',
    enabled: true
  });

  const dsh = createDshIntegration(store, { file: 'temp-settings.yaml' });
  const plan = dsh.plan();
  assert.deepEqual(plan.changes[0].defaultInput, ['text', 'image']);
  const model = plan.changes[0].models.find(m => m.id === 'strata/qwen3.8-flash-next-coder-iq1_m');
  assert.ok(model);
  assert.deepEqual(model.input, ['text', 'image']);
});

test('end-to-end Anthropic Messages route with image input passes image_url to OpenAI endpoint', async t => {
  let receivedBody = null;
  const mockUpstream = await listen(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    receivedBody = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'chatcmpl-test-vision',
      object: 'chat.completion',
      created: 12345,
      model: 'qwen3.8-flash-next-coder-iq1_m',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'The image is a valid WebP.' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    }));
  });

  const store = memory();
  store.data.endpoints.push({
    id: 'ep-strata',
    baseUrl: mockUpstream,
    allowPrivate: true,
    protocol: 'openai',
    enabled: true
  });
  store.data.routes.push({
    id: 'strata/qwen3.8-flash-next-coder-iq1_m',
    name: 'strata/qwen3.8-flash-next-coder-iq1_m',
    endpointId: 'ep-strata',
    upstreamId: 'qwen3.8-flash-next-coder-iq1_m',
    enabled: true,
    effort: { mode: 'forward', supported: [] }
  });

  const app = createApp(store);
  const base = await listen(t, app);

  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'strata/qwen3.8-flash-next-coder-iq1_m',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe what you see' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/webp',
                data: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4H'
              }
            }
          ]
        }
      ]
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.role, 'assistant');
  assert.equal(data.content[0].text, 'The image is a valid WebP.');
  assert.ok(receivedBody);
  assert.equal(receivedBody.model, 'qwen3.8-flash-next-coder-iq1_m');
  assert.deepEqual(receivedBody.messages[0].content, [
    { type: 'text', text: 'Describe what you see' },
    { type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4H' } }
  ]);
});
