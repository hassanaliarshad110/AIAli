// The tools the AI can use. The same list powers the built-in chat and the connector for Claude / ChatGPT.
import { ledger, cached } from './ledger/index.js';
import { checkDraft } from './checks.js';
import * as ap from './ap.js';
import { bool } from './config.js';
import { normName } from './util.js';

const LINE = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    amount: { type: 'number', description: 'Line amount before tax.' },
    account_id: { type: 'string', description: 'Expense account id from list_accounts.' },
    tax_code: { type: 'string', description: 'Optional tax code id from list_accounts. Leave out if unsure.' },
  },
  required: ['description', 'amount', 'account_id'],
};
const DRAFT = {
  type: 'object',
  properties: {
    vendor_name: { type: 'string', description: 'Vendor name exactly as on the invoice, or the matching vendor name from search_vendors.' },
    vendor_id: { type: 'string', description: 'Vendor id from search_vendors, if the vendor exists.' },
    vendor_email: { type: 'string' },
    invoice_number: { type: 'string' },
    invoice_date: { type: 'string', description: 'YYYY-MM-DD' },
    due_date: { type: 'string', description: 'YYYY-MM-DD. Leave out if the invoice has no due date or terms.' },
    currency: { type: 'string', description: 'ISO code, e.g. CAD, USD, AED.' },
    po_number: { type: 'string', description: 'Purchase order number if the invoice quotes one.' },
    lines: { type: 'array', items: LINE, minItems: 1 },
    subtotal: { type: 'number', description: 'Total before tax, as printed.' },
    tax: { type: 'number', description: 'Total tax as printed (0 if none).' },
    total: { type: 'number', description: 'Grand total as printed.' },
    file_id: { type: 'string', description: 'The file id given with the uploaded invoice, if any.' },
    notes: { type: 'string', description: 'Anything a reviewer should know: unclear fields, assumptions made.' },
  },
  required: ['vendor_name', 'invoice_number', 'invoice_date', 'lines', 'tax', 'total'],
};

export function toolList() {
  const t = [
    { name: 'ap_summary', description: 'Accounts payable overview: total outstanding, overdue, due in the next 7 days, aging buckets, top vendors by balance, and how many bills wait for approval.', input_schema: { type: 'object', properties: { as_of: { type: 'string', description: 'YYYY-MM-DD, default today' } } } },
    { name: 'list_bills', description: 'List bills from the ledger, sorted by due date.', input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'overdue', 'due_soon', 'all'], description: 'due_soon = due in the next 14 days' }, vendor: { type: 'string', description: 'Filter by part of the vendor name' }, limit: { type: 'number' } } } },
    { name: 'search_vendors', description: 'Find vendors in the ledger by name. Use before proposing a bill to get the vendor_id.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'list_accounts', description: 'Expense accounts and tax codes available for coding a bill.', input_schema: { type: 'object', properties: {} } },
    { name: 'list_purchase_orders', description: 'Open purchase orders, optionally for one vendor.', input_schema: { type: 'object', properties: { vendor: { type: 'string' } } } },
    { name: 'check_invoice', description: 'Run the AP controls on an invoice without saving anything: required fields, vendor match, GL accounts, arithmetic, tax rate, duplicates, PO match.', input_schema: DRAFT },
    { name: 'propose_bill', description: 'Put a bill in the approval queue. It is NOT posted: a person reviews and approves it in the web app. Run check_invoice first and fix anything you can.', input_schema: DRAFT },
    { name: 'approval_queue', description: 'Bills waiting for approval, posted or rejected.', input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'posted', 'rejected', 'all'] } } } },
  ];
  if (bool('ALLOW_AI_POSTING')) {
    t.push({ name: 'approve_and_post', description: 'Post a pending bill to the accounting system. Only call this when the user has explicitly told you to post that specific bill.', input_schema: { type: 'object', properties: { id: { type: 'string' }, acknowledge_warnings: { type: 'boolean', description: 'True only if the user has seen and accepted the warnings.' } }, required: ['id'] } });
  }
  return t;
}

const slim = (q) => ({ id: q.id, status: q.status, vendor: q.draft.vendor.name, invoice_number: q.draft.number, date: q.draft.date, due: q.draft.dueDate, total: q.draft.total, currency: q.draft.currency, checks: q.checks.result, findings: q.checks.findings.map((f) => `${f.level}: ${f.message}`), posted: q.posted ? { ledger_id: q.posted.id, url: q.posted.url } : undefined });

export async function runTool(name, args = {}, ctx = {}) {
  const L = ledger();
  switch (name) {
    case 'ap_summary': return ap.summary({ asOf: args.as_of || undefined });
    case 'list_bills': return ap.listBills(args);
    case 'search_vendors': {
      const all = await cached('vendors', () => L.listVendors());
      const qn = normName(args.query);
      const words = String(args.query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const scored = all.map((v) => {
        const n = normName(v.name), low = v.name.toLowerCase();
        const s = n === qn ? 3 : n.includes(qn) || qn.includes(n) ? 2 : words.filter((w) => low.includes(w)).length ? 1 : 0;
        return { v, s };
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 10);
      return { matches: scored.map((x) => x.v), note: scored.length ? undefined : 'No match. If this is a new vendor, propose the bill with vendor_name only; it will be created on approval.' };
    }
    case 'list_accounts': return { accounts: await cached('accounts', () => L.listAccounts()), tax_codes: await cached('taxcodes', () => L.listTaxCodes()) };
    case 'list_purchase_orders': {
      let pos = await cached('pos', () => L.listPurchaseOrders());
      if (args.vendor) pos = pos.filter((p) => (p.vendorName || '').toLowerCase().includes(args.vendor.toLowerCase()));
      return { purchase_orders: pos };
    }
    case 'check_invoice': { const c = await checkDraft(withFile(args, ctx)); return { result: c.result, findings: c.findings, resolved: { vendor: c.draft.vendor, due_date: c.draft.dueDate, lines: c.draft.lines } }; }
    case 'propose_bill': {
      const r = await ap.propose(withFile(args, ctx), { by: ctx.by || 'ai', source: ctx.source || 'chat' });
      return { queued: r.queued, id: r.id, reason: r.reason, note: r.note, result: r.checks.result, findings: r.checks.findings };
    }
    case 'approval_queue': return { items: ap.queue({ status: args.status || 'pending' }).map(slim) };
    case 'approve_and_post': {
      if (!bool('ALLOW_AI_POSTING')) throw new Error('Posting by AI is turned off. Approve the bill in the web app.');
      return slim(await ap.approve(args.id, { by: ctx.by || 'ai', acknowledgeWarnings: !!args.acknowledge_warnings }));
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}
// Invoices uploaded in the web app carry a file id; attach it even if the model forgot to pass it.
const withFile = (args, ctx) => (ctx.fileId && !args.file_id ? { ...args, file_id: ctx.fileId } : args);
