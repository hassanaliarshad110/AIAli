// The chat agent: sends the conversation to Claude or OpenAI, runs the tools it asks for, and loops until it answers.
import { get } from './config.js';
import { anthropic } from './llm/anthropic.js';
import { openai } from './llm/openai.js';
import { toolList, runTool } from './tools.js';
import { ledger } from './ledger/index.js';
import { today } from './util.js';
import { id } from './store.js';

const PROVIDERS = { anthropic, openai };
export const provider = () => PROVIDERS[get('AI_PROVIDER')] || anthropic;
const MAX_STEPS = 14;

async function systemPrompt() {
  const info = await ledger().info().catch(() => ({}));
  return `You are an accounts payable assistant for ${info.company || 'this company'}. Today is ${today()}. The connected ledger is ${ledger().label}${info.currency ? ` (base currency ${info.currency})` : ''}.

You help with two kinds of work:
1. Invoices. When an invoice file is attached, read it carefully and extract: vendor, invoice number, invoice date, due date (or terms such as "Net 30", converted to a date), currency, PO number, each line with its amount before tax, subtotal, tax and total. Then:
   - search_vendors to find the vendor (use its vendor_id when found),
   - list_accounts to pick the right expense account for each line, based on what was bought and the account names,
   - check_invoice, fix anything you misread, then propose_bill.
   Proposing never posts anything: a person approves every bill in the Approvals screen. Never say a bill is posted unless a tool result says so.
2. Questions about payables: what is due, what is overdue, aging, vendor balances. Use ap_summary and list_bills, never guess numbers.

Rules:
- Use only numbers from the invoice or from tools. If a field is unreadable or missing, say so in notes instead of inventing it.
- Dates are YYYY-MM-DD. Amounts are plain numbers.
- If check_invoice reports a duplicate, do not propose the bill; explain what already exists.
- Keep answers short and clear for a finance team. Use a small table when listing several bills. Show amounts with two decimals and the currency.`;
}

const sessions = new Map();
export function newSession() { const s = { id: id('chat'), provider: provider().name, messages: [], created: Date.now() }; sessions.set(s.id, s); return s; }
export const getSession = (sid) => sessions.get(sid);

// Runs one user turn. onEvent gets progress updates ({type:'tool', name, args} / {type:'tool_result', ...}) for the UI.
export async function runTurn({ sessionId, text, file, fileId, source = 'chat', onEvent = () => {} }) {
  const P = provider();
  if (!P.ready()) throw new Error(`No ${P.name === 'openai' ? 'OpenAI' : 'Anthropic'} API key. Add one in Settings.`);
  let s = sessionId && sessions.get(sessionId);
  if (!s || s.provider !== P.name) s = newSession();
  const tools = toolList();
  const system = await systemPrompt();
  const prompt = file ? `${text || 'Process this invoice.'}\n\n(Attached invoice file: "${file.name}", file_id: ${fileId})` : text;
  s.messages.push(P.userMessage(prompt, file));
  const actions = [];
  let answer = '';
  for (let stepNo = 0; stepNo < MAX_STEPS; stepNo++) {
    const r = await P.step({ system, messages: s.messages, tools });
    if (r.text) answer = r.text;
    if (!r.calls.length) break;
    const results = [];
    for (const c of r.calls) {
      onEvent({ type: 'tool', name: c.name, args: c.args });
      try {
        const out = await runTool(c.name, c.args, { fileId, source, by: `ai:${P.name}` });
        actions.push({ tool: c.name, args: c.args, ok: true, out });
        results.push({ id: c.id, content: JSON.stringify(out).slice(0, 60000) });
        onEvent({ type: 'tool_result', name: c.name, ok: true, out });
      } catch (e) {
        actions.push({ tool: c.name, args: c.args, ok: false, error: e.message });
        results.push({ id: c.id, content: JSON.stringify({ error: e.message }), error: true });
        onEvent({ type: 'tool_result', name: c.name, ok: false, error: e.message });
      }
    }
    P.addResults(s.messages, results);
    if (stepNo === MAX_STEPS - 1) answer ||= 'I stopped after too many steps. Try a narrower question.';
  }
  // Uploaded files are large: keep them for this turn only, so later turns stay fast and cheap.
  stripFiles(s.messages);
  return { sessionId: s.id, answer, actions };
}

function stripFiles(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.map((p) => (['document', 'image', 'file', 'image_url'].includes(p.type) ? { type: 'text', text: '[invoice file was attached here]' } : p));
  }
}
