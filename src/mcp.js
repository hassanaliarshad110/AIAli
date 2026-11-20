// Model Context Protocol server: lets Claude, ChatGPT or any MCP client use the AP tools directly.
// Stateless JSON-RPC, served over Streamable HTTP (src/server.js) and stdio (src/mcp-stdio.js).
import { toolList, runTool } from './tools.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Accounts payable tools for the company's ledger (QuickBooks Online, Xero or the demo ledger).
When the user shares an invoice (PDF or image), read it yourself, then: search_vendors, list_accounts, check_invoice, propose_bill.
propose_bill only queues the bill: a person approves it in the Open AP Agent web app before anything is posted.
For questions about what is owed, due or overdue use ap_summary and list_bills; never guess figures.`;

async function handle(msg, ctx) {
  const { id, method, params = {} } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid request');
  if (id === undefined) return null; // notification: nothing to answer
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'open-ap-agent', title: 'Open AP Agent', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: toolList().map((t) => ({ name: t.name, title: t.name.replace(/_/g, ' '), description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: !['propose_bill', 'approve_and_post'].includes(t.name), destructiveHint: false } })) });
    case 'tools/call': {
      const name = params.name;
      if (!toolList().some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const out = await runTool(name, params.arguments || {}, { by: `mcp:${ctx.client || 'client'}`, source: 'connector' });
        return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out } });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}

export async function mcpHandle(body, ctx = {}) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, ctx)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handle(body, ctx);
}
