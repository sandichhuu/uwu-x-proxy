import { randomUUID } from 'node:crypto';
const bad = message => Object.assign(new Error(message), { status: 400 });
export function effortFrom(body) {
  const values = [body.reasoning_effort, body.reasoning?.effort, body.output_config?.effort].filter(x => x !== undefined);
  if (new Set(values).size > 1) throw bad('Conflicting reasoning effort fields');
  return values[0];
}
export function anthropicToOpenAI(body, resolved) {
  if (body.thinking || body.output_config?.format) throw bad('Thinking budgets and structured output conversion are not supported');
  const messages = [];
  if (body.system) {
    if (Array.isArray(body.system) && body.system.some(x => x.type !== 'text')) throw bad('Unsupported system block');
    messages.push({ role: 'system', content: typeof body.system === 'string' ? body.system : body.system.map(x => x.text).join('\n') });
  }
  for (const m of body.messages) {
    if (!['user', 'assistant'].includes(m.role)) throw bad('Invalid message role');
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) throw bad('Invalid message content');
    const text = [], calls = [], results = [];
    for (const block of m.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'tool_use' && m.role === 'assistant') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
      else if (block.type === 'tool_result' && m.role === 'user') {
        const content = block.content ?? '';
        if (Array.isArray(content) && content.some(x => x.type !== 'text')) throw bad('Unsupported tool result block');
        results.push({ role: 'tool', tool_call_id: block.tool_use_id, content: Array.isArray(content) ? content.map(x => x.text).join('\n') : content });
      } else throw bad(`Unsupported content block: ${block.type}`);
    }
    messages.push(...results);
    if (text.length || calls.length) messages.push({ role: m.role, content: text.join('\n') || null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  const payload = { model: resolved.upstreamId, messages, max_tokens: body.max_tokens, stream: !!body.stream };
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined) payload[key] = body[key];
  if (body.stop_sequences) payload.stop = body.stop_sequences;
  if (body.tools) payload.tools = body.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (body.tool_choice) {
    const choice = body.tool_choice;
    if (!['auto', 'any', 'none', 'tool'].includes(choice.type)) throw bad('Unsupported tool choice');
    payload.tool_choice = choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type;
    if (choice.disable_parallel_tool_use !== undefined) payload.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (resolved.effort) payload.reasoning_effort = resolved.effort;
  return payload;
}
export function openAIToAnthropic(data, publicModel) {
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error('Invalid upstream response');
  const content = [];
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const call of choice.message.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
  return { id: data.id || `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: publicModel, content, stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 } };
}
