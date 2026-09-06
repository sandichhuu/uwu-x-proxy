import { randomUUID } from 'node:crypto';
export function anthropicToResponses(body, resolved) {
  const input = [];
  if (body.system) input.push({ role: 'system', content: typeof body.system === 'string' ? body.system : body.system.filter(x => x.type === 'text').map(x => x.text).join('\n') });
  for (const message of body.messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const text = blocks.filter(x => x.type === 'text').map(x => x.text).join('\n');
    if (text) input.push({ type: 'message', role: message.role, content: text });
    for (const block of blocks) {
      if (block.type === 'tool_use') input.push({ type: 'function_call', id: codexId(block.id), call_id: codexId(block.id), name: block.name, arguments: JSON.stringify(block.input || {}) });
      if (block.type === 'tool_result') input.push({ type: 'function_call_output', call_id: codexId(block.tool_use_id), output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) });
    }
  }
  const payload = { model: resolved.upstreamId, input, instructions: '', tools: (body.tools || []).map(x => ({ type: 'function', name: x.name, description: x.description || '', parameters: x.input_schema })), tool_choice: body.tool_choice?.type === 'tool' ? { type: 'function', name: body.tool_choice.name } : body.tool_choice?.type || 'auto', parallel_tool_calls: body.tool_choice?.disable_parallel_tool_use !== true, stream: true, store: false };
  if (resolved.effort) payload.reasoning = { effort: resolved.effort }; return payload;
}
const codexId = id => id?.startsWith('fc_') ? id : `fc_${(id || randomUUID()).replace(/^(call_|toolu_)/, '')}`;
export function responsesToAnthropic(response, publicModel) {
  const content = [];
  for (const item of response?.output || []) {
    if (item.type === 'message') for (const part of typeof item.content === 'string' ? [{ type: 'output_text', text: item.content }] : item.content || []) if (part.type === 'output_text' || part.type === 'text') content.push({ type: 'text', text: part.text });
    if (item.type === 'function_call') { let value = {}; try { value = JSON.parse(item.arguments || '{}'); } catch {} content.push({ type: 'tool_use', id: `toolu_${(item.call_id || item.id).replace(/^fc_/, '')}`, name: item.name, input: value }); }
  }
  return { id: response?.id?.replace(/^resp_/, 'msg_') || `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: publicModel, content: content.length ? content : [{ type: 'text', text: '' }], stop_reason: content.some(x => x.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: response?.usage?.input_tokens || 0, output_tokens: response?.usage?.output_tokens || 0 } };
}
export async function readCompletedResponse(upstream) {
  const decoder = new TextDecoder(); let buffer = '', completed;
  // This Responses API revision sends an empty output array on
  // response.completed; the finished items arrive via output_item.done.
  const items = [];
  for await (const chunk of upstream.body) { buffer += decoder.decode(chunk, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) if (line.startsWith('data:')) { try { const event = JSON.parse(line.slice(5)); if (event.type === 'response.output_item.done' && event.item) items[event.output_index ?? items.length] = event.item; if (event.type === 'response.completed') completed = event.response; } catch {} } }
  if (!completed) throw new Error('Codex stream ended without response.completed');
  if ((!completed.output?.length) && items.some(Boolean)) completed = { ...completed, output: items.filter(Boolean) };
  return completed;
}

export async function streamCodexToAnthropic(upstream, res, publicModel, signal) {
  const decoder = new TextDecoder(); let buffer = '', started = false, index = -1, current, input = 0, output = 0, stopped = false;
  const write = async event => { const value = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; if (!res.write(value)) await new Promise((resolve, reject) => { res.once('drain', resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); };
  const start = async id => { if (started) return; started = true; await write({ type: 'message_start', message: { id: id?.replace(/^resp_/, 'msg_') || `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: publicModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }); };
  const close = async () => { if (current) { await write({ type: 'content_block_stop', index }); current = undefined; } };
  const process = async event => {
    if (event.type === 'response.created') await start(event.response?.id);
    if (event.type === 'response.output_item.added') { await start(event.response_id); await close(); index++; const item = event.item || {}; if (item.type === 'function_call') { current = 'tool'; await write({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${(item.call_id || item.id || randomUUID()).replace(/^fc_/, '')}`, name: item.name, input: {} } }); } else if (item.type === 'reasoning') { current = 'thinking'; await write({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }); } else { current = 'text'; await write({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }); } }
    if (event.type === 'response.output_text.delta') await write({ type: 'content_block_delta', index, delta: current === 'thinking' ? { type: 'thinking_delta', thinking: event.delta || '' } : { type: 'text_delta', text: event.delta || '' } });
    if (event.type === 'response.reasoning.delta' || event.type === 'response.thinking.delta') await write({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: event.delta || event.thinking || '' } });
    if (event.type === 'response.function_call_arguments.delta') await write({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: event.delta || '' } });
    if (event.type === 'response.completed') { await start(event.response?.id); await close(); input = event.response?.usage?.input_tokens || 0; output = event.response?.usage?.output_tokens || 0; const tool = (event.response?.output || []).some(x => x.type === 'function_call'); await write({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: output } }); await write({ type: 'message_stop' }); stopped = true; }
    if (event.type === 'error' || event.type === 'response.failed') { await write({ type: 'error', error: { type: 'api_error', message: 'OpenAI Codex request failed' } }); stopped = true; }
  };
  for await (const chunk of upstream.body) { buffer += decoder.decode(chunk, { stream: true }); const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || ''; for (const frame of frames) { const data = frame.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n'); if (data && data !== '[DONE]') await process(JSON.parse(data)); } }
  if (!stopped) throw new Error('Codex stream ended before completion'); return { input, output };
}
