import express from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { auth } from '../security/auth.js';
import { resolveModel } from '../core/models.js';
import { executeOpenAI } from '../providers/api-endpoint.js';
import { executeCodex } from '../providers/openai-codex.js';
import { executeGoogle } from '../providers/google-antigravity.js';
import { anthropicToGemini, openAIToGemini, geminiToAnthropic, geminiToOpenAI, streamGeminiToAnthropic, streamGeminiToOpenAI, unwrapGemini } from '../providers/google-converter.js';
import { anthropicToResponses, responsesToAnthropic, readCompletedResponse, streamCodexToAnthropic } from '../providers/codex-converter.js';
import { anthropicToOpenAI, openAIToAnthropic, effortFrom } from '../core/protocols.js';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function error(res, e, anthropic = false) {
  if (res.headersSent) return res.destroy();
  const status = e.status || 502;
  // Only genuine upstream outages stay masked; client errors and explicit 501s
  // keep their real message so misconfiguration is diagnosable.
  const masked = status === 502 || status === 503 || status === 504;
  const detail = { message: masked ? `Upstream request failed${e.upstreamStatus ? `: HTTP ${e.upstreamStatus}` : ''}` : e.message, type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error' };
  res.status(status).json(anthropic ? { type: 'error', error: detail } : { error: detail });
}
// Codex streams SSE without a content-type header, so a missing header must be
// accepted. Only an explicitly non-SSE content type is a protocol violation.
function isSse(upstream) {
  const contentType = upstream.headers.get('content-type') || '';
  return !contentType || contentType.includes('text/event-stream');
}
// Decode complete SSE frames so JSON and UTF-8 fragments are never split.
// Cross-protocol streams are converted event-by-event instead of forwarding an
// OpenAI wire format to Anthropic clients.
async function streamResponse(upstream, res, publicId, signal, toAnthropic = false) {
  const decoder = new TextDecoder();
  let buffer = '';
  const write = async value => {
    if (!res.write(value)) await once(res, 'drain', { signal });
  };
  const anthropic = toAnthropic ? createAnthropicStream(publicId) : null;
  async function emit(frame) {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
    if (!data) return write(frame + '\n\n');
    if (anthropic) {
      const events = data === '[DONE]' ? anthropic.finish() : anthropic.push(JSON.parse(data));
      for (const event of events) await write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return;
    }
    if (data !== '[DONE]') {
      const value = JSON.parse(data);
      if (value.model) value.model = publicId;
      if (value.message?.model) value.message.model = publicId;
      if (value.response?.model) value.response.model = publicId;
      frame = [...lines.filter(x => !x.startsWith('data:')), `data: ${JSON.stringify(value)}`].join('\n');
    }
    await write(frame + '\n\n');
  }
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      await emit(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (buffer.length > 2 * 1024 * 1024) throw new Error('Oversized SSE frame');
  }
  buffer += decoder.decode();
  if (buffer.trim()) await emit(buffer);
  if (anthropic && !anthropic.finished) {
    for (const event of anthropic.finish()) await write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}
function createAnthropicStream(publicId) {
  let started = false, finished = false, textIndex, nextIndex = 0, stopReason = 'end_turn';
  let outputTokens = 0;
  const openBlocks = new Set(), tools = new Map();
  const start = value => {
    if (started) return [];
    started = true;
    return [{ type: 'message_start', message: { id: value.id || `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: publicId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: value.usage?.prompt_tokens || 0, output_tokens: 0 } } }];
  };
  const closeBlocks = () => [...openBlocks].sort((a, b) => a - b).map(index => ({ type: 'content_block_stop', index }));
  return {
    get finished() { return finished; },
    push(value) {
      if (finished) return [];
      if (value.error) {
        finished = true;
        return [{ type: 'error', error: { type: value.error.type || 'api_error', message: value.error.message || 'Upstream streaming error' } }];
      }
      const events = start(value);
      if (value.usage) outputTokens = value.usage.completion_tokens ?? value.usage.output_tokens ?? outputTokens;
      const choice = value.choices?.[0];
      if (!choice) return events;
      const delta = choice.delta || {};
      if (delta.content) {
        if (textIndex === undefined) {
          textIndex = nextIndex++;
          openBlocks.add(textIndex);
          events.push({ type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
        }
        events.push({ type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const part of delta.tool_calls || []) {
        const key = part.index ?? tools.size;
        let tool = tools.get(key);
        if (!tool) {
          tool = { index: nextIndex++, id: part.id || `toolu_${key}`, name: part.function?.name || '' };
          tools.set(key, tool); openBlocks.add(tool.index);
          events.push({ type: 'content_block_start', index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
        }
        if (part.function?.arguments) events.push({ type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: part.function.arguments } });
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason;
      }
      return events;
    },
    finish() {
      if (finished) return [];
      finished = true;
      const events = started ? closeBlocks() : start({});
      events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
      events.push({ type: 'message_stop' });
      return events;
    }
  };
}
export async function run(store, req, res, kind) {
  const started = Date.now(), controller = new AbortController();
  let timer, status = 502, tokens, resolved;
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', onClose);
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('JSON object required');
    if (kind === 'responses') {
      if (body.input === undefined) throw fail('input is required');
      if (body.background || body.store === true || body.previous_response_id) throw fail('Stored/background responses are not supported');
    } else if (!Array.isArray(body.messages) || !body.messages.length) throw fail('messages must be a non-empty array');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw fail('stream must be boolean');
    resolved = resolveModel(store, body.model, effortFrom(body));
    const codex = resolved.provider === 'openai';
    const google = resolved.provider === 'google';
    const nativeAnthropic = resolved.endpoint?.protocol === 'anthropic';
    if (codex && kind !== 'anthropic') throw fail('Codex accounts currently support the Anthropic Messages route; use /v1/messages', 501);
    if (google && kind === 'responses') throw fail('Google accounts do not support the Responses route; use /v1/messages', 501);
    if (nativeAnthropic && kind !== 'anthropic') throw fail('OpenAI to Anthropic conversion is not implemented', 501);
    timer = setTimeout(() => controller.abort(), resolved.endpoint?.timeoutMs || 120000);
    if (google) {
      const wantStream = body.stream === true;
      const inner = kind === 'anthropic' ? anthropicToGemini(body, resolved) : openAIToGemini(body, resolved);
      const upstream = await executeGoogle(store, resolved.account, inner, resolved.upstreamId, controller.signal, { stream: wantStream });
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        throw fail(`Upstream returned HTTP ${upstream.status}`, upstream.status);
      }
      if (wantStream) {
        if (!isSse(upstream)) { await upstream.body?.cancel().catch(() => {}); throw new Error('Expected SSE'); }
        res.set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        if (kind === 'anthropic') await streamGeminiToAnthropic(upstream, res, body.model, controller.signal);
        else await streamGeminiToOpenAI(upstream, res, body.model, controller.signal);
        res.end();
      } else {
        const data = unwrapGemini(await upstream.json());
        const result = kind === 'anthropic' ? geminiToAnthropic(data, body.model) : geminiToOpenAI(data, body.model);
        const usage = data.usageMetadata || {};
        tokens = usage.totalTokenCount ?? ((usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0) || undefined);
        res.json(result);
      }
    } else if (codex) {
      // The Codex Responses API always streams upstream; the client's own
      // stream flag decides whether we relay SSE or return one JSON message.
      const wantStream = body.stream === true;
      const payload = anthropicToResponses(body, resolved);
      const upstream = await executeCodex(store, resolved.account, payload, controller.signal);
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        throw fail(`Upstream returned HTTP ${upstream.status}`, upstream.status);
      }
      if (wantStream) {
        if (!isSse(upstream)) { await upstream.body?.cancel().catch(() => {}); throw new Error('Expected SSE'); }
        res.set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        await streamCodexToAnthropic(upstream, res, body.model, controller.signal);
        res.end();
      } else {
        const data = await readCompletedResponse(upstream);
        const result = responsesToAnthropic(data, body.model);
        tokens = data.usage?.total_tokens ?? (data.usage ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0) : undefined);
        res.json(result);
      }
    } else {
      let payload = kind === 'anthropic' && !nativeAnthropic ? anthropicToOpenAI(body, resolved) : { ...body, model: resolved.upstreamId };
      if (!(kind === 'anthropic' && !nativeAnthropic)) {
        delete payload.reasoning_effort;
        if (resolved.effort) {
          if (kind === 'responses') payload.reasoning = { ...body.reasoning, effort: resolved.effort };
          else if (kind === 'anthropic') payload.output_config = { ...body.output_config, effort: resolved.effort };
          else payload.reasoning_effort = resolved.effort;
        }
      }
      if (resolved.model.effort?.mode === 'variant') {
        delete payload.reasoning_effort;
        if (payload.reasoning) { payload.reasoning = { ...payload.reasoning }; delete payload.reasoning.effort; }
        if (payload.output_config) { payload.output_config = { ...payload.output_config }; delete payload.output_config.effort; }
      }
      const route = nativeAnthropic ? 'messages' : kind === 'responses' ? 'responses' : 'chat/completions';
      const upstream = await executeOpenAI(resolved.endpoint, payload, controller.signal, route);
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {});
        throw fail(`Upstream returned HTTP ${upstream.status}`, upstream.status);
      }
      if (payload.stream) {
        if (!isSse(upstream)) { await upstream.body?.cancel().catch(() => {}); throw new Error('Expected SSE'); }
        res.set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        await streamResponse(upstream, res, body.model, controller.signal, kind === 'anthropic' && !nativeAnthropic);
        res.end();
      } else {
        const data = await upstream.json();
        const result = kind === 'anthropic' && !nativeAnthropic ? openAIToAnthropic(data, body.model) : { ...data, model: body.model };
        tokens = data.usage?.total_tokens ?? (data.usage ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0) : undefined);
        res.json(result);
      }
    }
    status = 200;
  } catch (e) {
    status = controller.signal.aborted ? 504 : e.status || 502;
    if (status >= 500) console.error(`[inference] model=${req.body?.model} upstream=${resolved?.upstreamId} status=${status}: ${e.message}`);
    if (!res.destroyed) error(res, { status, message: e.message, upstreamStatus: e.upstreamStatus }, kind === 'anthropic');
  }
  finally {
    clearTimeout(timer); res.off('close', onClose);
    try { store.record({ at: new Date().toISOString(), model: req.body?.model, upstream: resolved?.upstreamId, effort: resolved?.effort, status, latencyMs: Date.now() - started, tokens }); } catch { /* Logging failure must not change a committed response. */ }
  }
}
export function inferenceRouter(store) {
  const r = express.Router(), guard = auth(store);
  const serialize = (m, anthropic) => anthropic ? { id: m.id, type: 'model', display_name: m.name || m.id, created_at: m.createdAt || '1970-01-01T00:00:00Z' } : { id: m.id, object: 'model', created: 0, owned_by: 'uwu-x-proxy' };
  r.get('/models', guard, (req, res) => {
    const anthropic = !!req.get('anthropic-version');
    const publicRegistry = store.list('routes').length ? store.list('routes') : store.list('models');
    let models = publicRegistry.filter(x => x.enabled !== false);
    if (!anthropic) return res.json({ object: 'list', data: models.map(m => serialize(m, false)) });
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (req.query.after_id && req.query.before_id)) return error(res, fail('Invalid pagination'), true);
    for (const key of ['after_id', 'before_id']) if (req.query[key]) {
      const index = models.findIndex(m => m.id === req.query[key]);
      if (index < 0) return error(res, fail('Unknown pagination cursor'), true);
      models = key === 'after_id' ? models.slice(index + 1) : models.slice(0, index);
    }
    const page = models.slice(0, limit);
    res.json({ data: page.map(m => serialize(m, true)), has_more: models.length > limit, first_id: page[0]?.id ?? null, last_id: page.at(-1)?.id ?? null });
  });
  r.get('/models/:id', guard, (req, res) => {
    const publicRegistry = store.list('routes').length ? store.list('routes') : store.list('models');
    const m = publicRegistry.find(x => x.id === req.params.id && x.enabled !== false);
    if (!m) return error(res, fail('Unknown model', 404), !!req.get('anthropic-version'));
    res.json(serialize(m, !!req.get('anthropic-version')));
  });
  for (const [route, kind] of [['/chat/completions', 'openai'], ['/responses', 'responses'], ['/messages', 'anthropic']]) r.post(route, guard, (q, s) => run(store, q, s, kind));
  r.post('/messages/count_tokens', guard, (_, res) => error(res, fail('Exact token counting is not available', 501), true));
  return r;
}
