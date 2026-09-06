import { randomUUID } from 'node:crypto';

const bad = message => Object.assign(new Error(message), { status: 400 });

const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT'
].map(category => ({ category, threshold: 'BLOCK_NONE' }));

const isThinkingModel = id => /thinking/i.test(id || '');

// Upstream rejects functionCall parts without a thoughtSignature (HTTP 400).
// Real signatures are remembered per tool id when upstream sends them; ids we
// never issued a signature for fall back to the officially supported sentinel.
const thoughtSignatures = new Map();
const MAX_SIG_CACHE = 2000;
const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
export function rememberThoughtSignature(id, sig) {
  if (!id || !sig) return;
  if (!thoughtSignatures.has(id) && thoughtSignatures.size >= MAX_SIG_CACHE) {
    thoughtSignatures.delete(thoughtSignatures.keys().next().value);
  }
  thoughtSignatures.set(id, sig);
}
const thoughtSignatureFor = id => thoughtSignatures.get(id) || SKIP_THOUGHT_SIGNATURE;

function toolResultToObject(content) {
  const text = Array.isArray(content)
    ? content.filter(x => x?.type === 'text').map(x => x.text).join('\n')
    : (typeof content === 'string' ? content : JSON.stringify(content ?? ''));
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { result: parsed };
  } catch {
    return { result: text };
  }
}

function generationConfigFrom(body) {
  const config = {};
  if (body.temperature !== undefined) config.temperature = Number(body.temperature);
  if (body.top_p !== undefined) config.topP = Number(body.top_p);
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens !== undefined && maxTokens !== null) config.maxOutputTokens = Number(maxTokens);
  if (body.stop_sequences) config.stopSequences = body.stop_sequences;
  else if (body.stop) config.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return config;
}

// Anthropic Messages -> Gemini generateContent inner request.
export function anthropicToGemini(body, resolved) {
  const toolNameById = new Map();
  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    for (const b of blocks) if (b?.type === 'tool_use' && b.id) toolNameById.set(b.id, b.name);
  }
  let systemText = '';
  if (body.system) {
    if (typeof body.system === 'string') systemText = body.system;
    else if (Array.isArray(body.system)) {
      if (body.system.some(x => x?.type !== 'text')) throw bad('Unsupported system block');
      systemText = body.system.map(x => x.text).join('\n');
    }
  }
  const contents = [];
  for (const m of body.messages || []) {
    if (!['user', 'assistant'].includes(m.role)) throw bad('Invalid message role');
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (!Array.isArray(blocks)) throw bad('Invalid message content');
    if (m.role === 'user') {
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text') { if (b.text) parts.push({ text: b.text }); }
        else if (b.type === 'tool_result') {
          parts.push({ functionResponse: { name: toolNameById.get(b.tool_use_id) || 'tool_result', response: toolResultToObject(b.content) } });
        }
        else throw bad(`Unsupported content block: ${b.type}`);
      }
      if (parts.length) contents.push({ role: 'user', parts });
    } else {
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text') { if (b.text) parts.push({ text: b.text }); }
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') { /* Reasoning is not echoed back upstream. */ }
        else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} }, thoughtSignature: thoughtSignatureFor(b.id) });
        else throw bad(`Unsupported content block: ${b.type}`);
      }
      if (parts.length) contents.push({ role: 'model', parts });
    }
  }
  const request = { contents, systemInstruction: { parts: [{ text: systemText || 'You are a helpful AI assistant.' }] }, safetySettings: SAFETY_SETTINGS };
  if (body.tools?.length) {
    request.tools = [{
      functionDeclarations: body.tools.map(t => ({
        name: t.name,
        description: t.description || '',
        ...(t.input_schema ? { parameters: t.input_schema } : {})
      }))
    }];
    const choice = body.tool_choice;
    if (choice) {
      if (!['auto', 'any', 'none', 'tool'].includes(choice.type)) throw bad('Unsupported tool choice');
      const mode = choice.type === 'auto' ? 'AUTO' : choice.type === 'none' ? 'NONE' : 'ANY';
      request.toolConfig = { functionCallingConfig: { mode } };
      if (choice.type === 'tool') request.toolConfig.functionCallingConfig.allowedFunctionNames = [choice.name];
      if (choice.disable_parallel_tool_use !== undefined) request.toolConfig.functionCallingConfig.mode = mode;
    }
  }
  const generationConfig = generationConfigFrom(body);
  if (isThinkingModel(resolved?.upstreamId)) {
    generationConfig.thinkingConfig = { ...(generationConfig.thinkingConfig || {}), includeThoughts: true };
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  return request;
}

// OpenAI message content can be a string or an array of parts. Text-like
// parts are concatenated; image parts are rejected explicitly so the client
// gets a clear 400 instead of an opaque upstream INVALID_ARGUMENT.
function openAIContentToText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const chunks = [];
    for (const block of content) {
      if (typeof block === 'string') { chunks.push(block); continue; }
      const type = block?.type || 'text';
      if (type === 'text' || type === 'input_text') chunks.push(block.text || '');
      else if (type === 'image_url' || type === 'input_image') throw bad('Image content is not supported');
      else throw bad(`Unsupported content block: ${type}`);
    }
    return chunks.filter(Boolean).join('\n');
  }
  return String(content);
}

// OpenAI Chat Completions -> Gemini generateContent inner request.
export function openAIToGemini(body, resolved) {
  const toolNameById = new Map();
  for (const m of body.messages || []) for (const tc of m.tool_calls || []) if (tc?.id && tc.function?.name) toolNameById.set(tc.id, tc.function.name);
  const systemTexts = [], contents = [];
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = openAIContentToText(m.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      const text = openAIContentToText(m.content);
      contents.push({ role: 'function', parts: [{ functionResponse: { name: m.name || toolNameById.get(m.tool_call_id) || 'tool_result', response: toolResultToObject(text) } }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      const text = openAIContentToText(m.content);
      if (text) parts.push({ text });
      for (const tc of m.tool_calls || []) {
        if (!tc.function?.name) continue;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { raw: String(tc.function.arguments || '') }; }
        parts.push({ functionCall: { name: tc.function.name, args }, thoughtSignature: thoughtSignatureFor(tc.id) });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'user') {
      const text = openAIContentToText(m.content);
      if (text) contents.push({ role: 'user', parts: [{ text }] });
      continue;
    }
    throw bad('Invalid message role');
  }
  if (!contents.length) throw bad('messages must contain convertible text content');
  const request = { contents, systemInstruction: { parts: [{ text: systemTexts.join('\n\n') || 'You are a helpful AI assistant.' }] }, safetySettings: SAFETY_SETTINGS };
  if (body.tools?.length) {
    const decls = [];
    for (const t of body.tools) {
      const fn = t.type === 'function' ? t.function : t;
      if (fn?.name) decls.push({ name: fn.name, description: fn.description || '', ...(fn.parameters ? { parameters: fn.parameters } : {}) });
    }
    if (decls.length) request.tools = [{ functionDeclarations: decls }];
  }
  if (body.tool_choice) {
    const mode = body.tool_choice === 'auto' ? 'AUTO' : body.tool_choice === 'none' ? 'NONE' : 'ANY';
    request.toolConfig = { functionCallingConfig: { mode } };
  }
  if (body.parallel_tool_calls !== undefined) request.toolConfig = request.toolConfig || { functionCallingConfig: { mode: 'AUTO' } };
  const generationConfig = generationConfigFrom(body);
  if (isThinkingModel(resolved?.upstreamId)) {
    generationConfig.thinkingConfig = { ...(generationConfig.thinkingConfig || {}), includeThoughts: false };
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  return request;
}

const toolUseId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

// Unwrap the Cloud Code envelope: {"response": {...}} or a bare response.
export const unwrapGemini = payload => (payload && typeof payload === 'object' && payload.response && typeof payload.response === 'object' ? payload.response : payload);

function geminiStopReason(candidate, hasTool) {
  if (hasTool) return 'tool_use';
  const reason = String(candidate?.finishReason || candidate?.stopReason || 'STOP').toUpperCase();
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  return 'end_turn';
}

// Gemini generateContent response -> Anthropic Messages response.
export function geminiToAnthropic(response, publicModel) {
  const data = unwrapGemini(response);
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content = [];
  for (const p of parts) {
    if (p.functionCall) {
      const id = p.functionCall.id || toolUseId();
      rememberThoughtSignature(id, p.thoughtSignature || p.thought_signature);
      content.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} });
    } else if (typeof p.text === 'string' && p.text) {
      content.push(p.thought ? { type: 'thinking', thinking: p.text } : { type: 'text', text: p.text });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const usage = data?.usageMetadata || {};
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content,
    stop_reason: geminiStopReason(candidate, content.some(x => x.type === 'tool_use')),
    stop_sequence: null,
    usage: { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || usage.completionTokenCount || 0 }
  };
}

// Gemini generateContent response -> OpenAI Chat Completion.
export function geminiToOpenAI(response, publicModel) {
  const data = unwrapGemini(response);
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  let text = '';
  const toolCalls = [];
  for (const p of parts) {
    if (p.functionCall) {
      const id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      rememberThoughtSignature(id, p.thoughtSignature || p.thought_signature);
      toolCalls.push({ id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } });
    } else if (typeof p.text === 'string' && !p.thought) text += p.text;
  }
  const rawReason = String(candidate?.finishReason || 'STOP').toUpperCase();
  const finishReason = toolCalls.length ? 'tool_calls' : rawReason === 'MAX_TOKENS' ? 'length' : rawReason === 'SAFETY' || rawReason === 'RECITATION' || rawReason === 'BLOCKLIST' ? 'content_filter' : 'stop';
  const usage = data?.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0, completionTokens = usage.candidatesTokenCount || 0;
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: usage.totalTokenCount || (promptTokens + completionTokens) }
  };
}

// Shared SSE frame reader: yields unwrapped Gemini chunks from an upstream body.
async function* readGeminiChunks(upstream) {
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = function* () {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      yield buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
    }
  };
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (const frame of frames()) {
      const data = frame.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield unwrapGemini(JSON.parse(data)); } catch { /* Skip partial frames; the decoder reassembles them. */ }
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Oversized SSE frame');
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n');
    if (data && data !== '[DONE]') {
      try { yield unwrapGemini(JSON.parse(data)); } catch { /* Trailing partial frame. */ }
    }
  }
}

// Gemini stream -> Anthropic Messages SSE.
export async function streamGeminiToAnthropic(upstream, res, publicId, signal) {
  let started = false, finished = false, nextIndex = 0, textIndex, thinkIndex;
  let stopReason = 'end_turn', outputTokens = 0, sawTool = false;
  const openBlocks = new Set();
  const write = async event => {
    const value = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    if (!res.write(value)) await new Promise((resolve, reject) => {
      res.once('drain', resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const start = async () => {
    if (started) return;
    started = true;
    await write({ type: 'message_start', message: { id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: publicId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const closeBlocks = async () => {
    for (const index of [...openBlocks].sort((a, b) => a - b)) await write({ type: 'content_block_stop', index });
    openBlocks.clear();
  };
  for await (const chunk of readGeminiChunks(upstream)) {
    await start();
    if (chunk.usageMetadata?.candidatesTokenCount !== undefined) outputTokens = chunk.usageMetadata.candidatesTokenCount;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (part.functionCall) {
        sawTool = true;
        const index = nextIndex++;
        openBlocks.add(index);
        const toolId = part.functionCall.id || toolUseId();
        rememberThoughtSignature(toolId, part.thoughtSignature || part.thought_signature);
        await write({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolId, name: part.functionCall.name, input: {} } });
        await write({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args ?? {}) } });
      } else if (typeof part.text === 'string' && part.text) {
        if (part.thought) {
          if (thinkIndex === undefined) {
            thinkIndex = nextIndex++;
            openBlocks.add(thinkIndex);
            await write({ type: 'content_block_start', index: thinkIndex, content_block: { type: 'thinking', thinking: '' } });
          }
          await write({ type: 'content_block_delta', index: thinkIndex, delta: { type: 'thinking_delta', thinking: part.text } });
        } else {
          if (textIndex === undefined) {
            textIndex = nextIndex++;
            openBlocks.add(textIndex);
            await write({ type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
          }
          await write({ type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: part.text } });
        }
      }
    }
    if (candidate?.finishReason) {
      const reason = String(candidate.finishReason).toUpperCase();
      stopReason = reason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
    }
  }
  await start();
  await closeBlocks();
  finished = true;
  await write({ type: 'message_delta', delta: { stop_reason: sawTool ? 'tool_use' : stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
  await write({ type: 'message_stop' });
  return { finished };
}

// Gemini stream -> OpenAI Chat Completions SSE.
export async function streamGeminiToOpenAI(upstream, res, publicId, signal) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let sentRole = false, toolIndex = 0, finishReason = 'stop';
  const write = async obj => {
    const value = `data: ${JSON.stringify(obj)}\n\n`;
    if (!res.write(value)) await new Promise((resolve, reject) => {
      res.once('drain', resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const delta = async d => {
    await write({ id, object: 'chat.completion.chunk', created, model: publicId, choices: [{ index: 0, delta: d, finish_reason: null }] });
  };
  for await (const chunk of readGeminiChunks(upstream)) {
    if (!sentRole) { sentRole = true; await delta({ role: 'assistant', content: '' }); }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (part.functionCall) {
        finishReason = 'tool_calls';
        const toolId = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        rememberThoughtSignature(toolId, part.thoughtSignature || part.thought_signature);
        await delta({ tool_calls: [{ index: toolIndex++, id: toolId, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }] });
      } else if (typeof part.text === 'string' && part.text && !part.thought) {
        await delta({ content: part.text });
      }
    }
    if (candidate?.finishReason) {
      const reason = String(candidate.finishReason).toUpperCase();
      finishReason = reason === 'MAX_TOKENS' ? 'length' : finishReason === 'tool_calls' ? 'tool_calls' : 'stop';
    }
  }
  if (!sentRole) await delta({ role: 'assistant', content: '' });
  await write({ id, object: 'chat.completion.chunk', created, model: publicId, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  res.write('data: [DONE]\n\n');
}
