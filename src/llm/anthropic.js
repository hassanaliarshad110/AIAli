// Claude via the Anthropic Messages API (tool use + native PDF reading).
import { get } from '../config.js';
import { readJson } from '../util.js';

const URL_ = () => (get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com') + '/v1/messages';

export const anthropic = {
  name: 'anthropic',
  ready: () => !!get('ANTHROPIC_API_KEY'),
  model: () => get('ANTHROPIC_MODEL'),
  userMessage(text, file) {
    const content = [];
    if (file) {
      const data = file.data.toString('base64');
      content.push(file.type === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: file.name }
        : { type: 'image', source: { type: 'base64', media_type: file.type, data } });
    }
    content.push({ type: 'text', text });
    return { role: 'user', content };
  },
  async step({ system, messages, tools }) {
    const res = await fetch(URL_(), {
      method: 'POST',
      headers: { 'x-api-key': get('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model(), max_tokens: 4096, system, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })), messages }),
    });
    const j = await readJson(res);
    if (!res.ok) throw new Error(`Claude API: ${j.error?.message || res.status}`);
    messages.push({ role: 'assistant', content: j.content });
    return {
      text: j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      calls: j.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
      usage: j.usage,
    };
  },
  addResults(messages, results) {
    messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.error ? { is_error: true } : {}) })) });
  },
};
