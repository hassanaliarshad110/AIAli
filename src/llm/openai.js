// OpenAI via the Chat Completions API (function calling + PDF/image input).
import { get } from '../config.js';
import { readJson } from '../util.js';

const URL_ = () => (get('OPENAI_BASE_URL') || 'https://api.openai.com/v1') + '/chat/completions';

export const openai = {
  name: 'openai',
  ready: () => !!get('OPENAI_API_KEY'),
  model: () => get('OPENAI_MODEL'),
  userMessage(text, file) {
    if (!file) return { role: 'user', content: text };
    const b64 = file.data.toString('base64');
    const part = file.type === 'application/pdf'
      ? { type: 'file', file: { filename: file.name, file_data: `data:application/pdf;base64,${b64}` } }
      : { type: 'image_url', image_url: { url: `data:${file.type};base64,${b64}` } };
    return { role: 'user', content: [part, { type: 'text', text }] };
  },
  async step({ system, messages, tools }) {
    const res = await fetch(URL_(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${get('OPENAI_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model(),
        messages: [{ role: 'system', content: system }, ...messages],
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      }),
    });
    const j = await readJson(res);
    if (!res.ok) throw new Error(`OpenAI API: ${j.error?.message || res.status}`);
    const m = j.choices?.[0]?.message || {};
    messages.push({ role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
    return {
      text: (m.content || '').trim(),
      calls: (m.tool_calls || []).map((c) => { let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch {} return { id: c.id, name: c.function.name, args }; }),
      usage: j.usage,
    };
  },
  addResults(messages, results) {
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
  },
};
