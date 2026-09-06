import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToGemini,
  openAIToGemini,
  geminiToAnthropic,
  geminiToOpenAI,
  unwrapGemini,
  rememberThoughtSignature
} from '../src/providers/google-converter.js';

test('anthropicToGemini maps system, turns and tools to Gemini parts', () => {
  const request = anthropicToGemini({
    system: 'Be helpful',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Hanoi' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }] }
    ],
    tools: [{ name: 'weather', description: 'wx', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
    max_tokens: 50
  }, { upstreamId: 'gemini-3.8-flash-medium' });
  assert.equal(request.systemInstruction.parts[0].text, 'Be helpful');
  assert.equal(request.contents[0].role, 'user');
  assert.equal(request.contents[1].role, 'model');
  assert.deepEqual(request.contents[1].parts[1], { functionCall: { name: 'weather', args: { city: 'Hanoi' } }, thoughtSignature: 'skip_thought_signature_validator' });
  assert.equal(request.contents[2].parts[0].functionResponse.name, 'weather');
  assert.equal(request.tools[0].functionDeclarations[0].name, 'weather');
  assert.equal(request.generationConfig.maxOutputTokens, 50);
});

test('anthropicToGemini rejects images and bad roles with 400', () => {
  assert.throws(() => anthropicToGemini({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }, {}), { status: 400 });
  assert.throws(() => anthropicToGemini({ messages: [{ role: 'system', content: 'x' }] }, {}), { status: 400 });
});

test('openAIToGemini maps tool history by id', () => {
  const request = openAIToGemini({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'book a flight' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'book', arguments: '{"to":"HAN"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }
    ],
    tools: [{ type: 'function', function: { name: 'book', description: '', parameters: { type: 'object' } } }]
  }, { upstreamId: 'gemini-3.8-flash-medium' });
  assert.equal(request.systemInstruction.parts[0].text, 'sys');
  assert.equal(request.contents[2].parts[0].functionResponse.name, 'book');
  assert.deepEqual(request.contents[2].parts[0].functionResponse.response, { ok: true });
});

test('geminiToAnthropic converts text, thinking and function calls', () => {
  const message = geminiToAnthropic({
    candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }, { text: 'hi' }, { functionCall: { name: 'weather', args: { city: 'Hanoi' } } }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 }
  }, 'public');
  assert.equal(message.model, 'public');
  assert.equal(message.content[0].type, 'thinking');
  assert.deepEqual(message.content[1], { type: 'text', text: 'hi' });
  assert.equal(message.content[2].type, 'tool_use');
  assert.deepEqual(message.content[2].input, { city: 'Hanoi' });
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.usage, { input_tokens: 7, output_tokens: 4 });
});

test('functionCall parts carry a remembered thoughtSignature, else the sentinel', () => {
  rememberThoughtSignature('toolu_known', 'real-sig-123');
  const request = anthropicToGemini({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_known', name: 'a', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_new', name: 'b', input: {} }] }
    ]
  }, {});
  assert.equal(request.contents[0].parts[0].thoughtSignature, 'real-sig-123');
  assert.equal(request.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');

  const reply = geminiToAnthropic({
    candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: {} }, thoughtSignature: 'sig-from-upstream' }] }, finishReason: 'STOP' }]
  }, 'public');
  const remembered = anthropicToGemini({
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: reply.content[0].id, name: 'a', input: {} }] }]
  }, {});
  assert.equal(remembered.contents[0].parts[0].thoughtSignature, 'sig-from-upstream');
});

test('geminiToOpenAI maps finish reasons and usage, unwraps envelopes', () => {
  const completion = geminiToOpenAI({ response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 } } }, 'public');
  assert.equal(completion.model, 'public');
  assert.equal(completion.choices[0].message.content, 'hi');
  assert.equal(completion.choices[0].finish_reason, 'length');
  assert.deepEqual(completion.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  assert.deepEqual(unwrapGemini({ a: 1 }), { a: 1 });
});
