// Fake Claude, OpenAI, QuickBooks and Xero servers so the whole flow can be tested offline.
import http from 'node:http';

export function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      let body = null; try { body = JSON.parse(raw.toString() || 'null'); } catch { body = raw; }
      const url = new URL(req.url, 'http://x');
      const out = await handler({ req, url, body, raw });
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}

// What a model would read off each sample invoice.
export const EXTRACT = {
  'northwind-INV-10458.pdf': { q: 'Northwind Office Supplies', d: { vendor_name: 'Northwind Office Supplies', invoice_number: 'INV-10458', invoice_date: '2026-11-14', due_date: '2026-12-14', currency: 'CAD', lines: [{ description: 'Printer paper, letter, case of 10 reams (12)', amount: 654, account_id: '6000', tax_code: 'GST' }, { description: 'Toner cartridge HP 58X, black (4)', amount: 756, account_id: '6000', tax_code: 'GST' }, { description: 'Desk organizer, mesh (10)', amount: 187.5, account_id: '6000', tax_code: 'GST' }], subtotal: 1597.5, tax: 79.88, total: 1677.38 } },
  'peakit-PIT-5601.pdf': { q: 'Peak IT Services', d: { vendor_name: 'Peak IT Services', invoice_number: 'PIT-5601', invoice_date: '2026-11-16', due_date: '2026-12-16', currency: 'CAD', po_number: 'PO-1007', lines: [{ description: 'Laptop, 14in, 32GB RAM, 1TB SSD (3)', amount: 4050, account_id: '6200', tax_code: 'GST' }, { description: 'Setup, imaging and data transfer (3)', amount: 375, account_id: '6200', tax_code: 'GST' }], subtotal: 4425, tax: 221.25, total: 4646.25 } },
  'bowriver-BRC-2291.pdf': { q: 'Bow River Cleaning', d: { vendor_name: 'Bow River Cleaning Co.', invoice_number: 'BRC-2291', invoice_date: '2026-11-02', currency: 'CAD', lines: [{ description: 'Janitorial services, October, 3 buildings', amount: 2700, account_id: '6100', tax_code: 'GST' }, { description: 'Window cleaning, exterior, Building B', amount: 450, account_id: '6100', tax_code: 'GST' }], subtotal: 3150, tax: 157.5, total: 3307.5 } },
  'chinook-catering-CC-0912.pdf': { q: 'Chinook Catering', d: { vendor_name: 'Chinook Catering Co.', vendor_email: 'orders@chinookcatering.example', invoice_number: 'CC-0912', invoice_date: '2026-11-17', due_date: '2026-11-17', currency: 'CAD', lines: [{ description: 'Board meeting lunch, 18 guests', amount: 576, account_id: '6700', tax_code: 'GST' }, { description: 'Delivery and setup', amount: 45, account_id: '6700', tax_code: 'GST' }], subtotal: 621, tax: 37.26, total: 658.26, notes: 'GST printed as 5% but the amount is 6% of the subtotal.' } },
  'parkside-PL-3349.png': { q: 'Parkside Landscaping', d: { vendor_name: 'Parkside Landscaping', invoice_number: 'PL-3349', invoice_date: '2026-11-15', due_date: '2026-11-30', currency: 'CAD', po_number: 'PO-1011', lines: [{ description: 'Fall clean-up, all sites (per PO-1011)', amount: 2100, account_id: '6600', tax_code: 'GST' }, { description: 'Additional leaf removal, Building C', amount: 260, account_id: '6600', tax_code: 'GST' }], subtotal: 2360, tax: 118, total: 2478 } },
};

// Decide the next "model" action from the conversation so far. Same script for both providers.
function plan(allText, toolResults) {
  const file = Object.keys(EXTRACT).find((f) => allText.includes(f));
  const n = toolResults.length;
  if (file) {
    const e = EXTRACT[file];
    const steps = [['search_vendors', { query: e.q }], ['list_accounts', {}], ['check_invoice', e.d]];
    if (n < steps.length) return { call: steps[n] };
    const check = JSON.parse(toolResults[2]);
    if (n === 3) {
      if (check.findings?.some((f) => f.code === 'duplicate')) return { text: `**Not queued: this is a duplicate.** ${check.findings.find((f) => f.code === 'duplicate').message}` };
      const vid = JSON.parse(toolResults[0]).matches?.[0]?.id;
      return { call: ['propose_bill', { ...e.d, ...(vid && e.q !== 'Chinook Catering' ? { vendor_id: vid } : {}) }] };
    }
    const p = JSON.parse(toolResults[3]);
    const warn = (p.findings || []).filter((f) => f.level !== 'info').map((f) => `- ${f.message}`).join('\n');
    return { text: `Read **${e.d.vendor_name} ${e.d.invoice_number}** for **CAD ${e.d.total.toFixed(2)}** and coded it to account ${e.d.lines[0].account_id}. It's in Approvals (${p.id}).${warn ? `\n\nNeeds a look:\n${warn}` : ' All checks passed.'}` };
  }
  if (n === 0) return { call: ['ap_summary', {}] };
  const s = JSON.parse(toolResults[0]);
  return { text: `You have **${s.openBills} open bills** totalling **CAD ${s.outstanding.toFixed(2)}**.\n\n| Bucket | Amount |\n|---|---|\n${s.aging.map((a) => `| ${a.name} | ${a.amount.toFixed(2)} |`).join('\n')}\n\n**CAD ${s.overdue.toFixed(2)}** is overdue across ${s.overdueCount} bills.` };
}

export const anthropicMock = (log = []) => serve(({ url, body, req }) => {
  if (url.pathname !== '/v1/messages') return { status: 404 };
  log.push({ key: req.headers['x-api-key'], body });
  const text = JSON.stringify(body.messages);
  const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_result').map((c) => c.content) : []));
  const p = plan(text, results);
  return { json: { id: 'msg', type: 'message', role: 'assistant', stop_reason: p.call ? 'tool_use' : 'end_turn', usage: {}, content: p.call ? [{ type: 'tool_use', id: `tu_${results.length}`, name: p.call[0], input: p.call[1] }] : [{ type: 'text', text: p.text }] } };
});

export const openaiMock = (log = []) => serve(({ url, body, req }) => {
  if (url.pathname !== '/v1/chat/completions') return { status: 404 };
  log.push({ auth: req.headers.authorization, body });
  const results = body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const p = plan(JSON.stringify(body.messages), results);
  return { json: { choices: [{ message: p.call ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${results.length}`, type: 'function', function: { name: p.call[0], arguments: JSON.stringify(p.call[1]) } }] } : { role: 'assistant', content: p.text } }] } };
});

// --- QuickBooks Online: just enough of the v3 API
export function qboMock(log = []) {
  const db = {
    Vendor: [{ Id: '56', DisplayName: 'Northwind Office Supplies', Active: true, PrimaryEmailAddr: { Address: 'ar@nw.example' }, CurrencyRef: { value: 'USD' } }],
    Account: [{ Id: '7', Name: 'Office Supplies', FullyQualifiedName: 'Office Supplies', AccountType: 'Expense', AcctNum: '6000', Active: true }, { Id: '35', Name: 'Checking', AccountType: 'Bank', Active: true }],
    TaxCode: [],
    Bill: [{ Id: '145', DocNumber: 'INV-10391', VendorRef: { value: '56', name: 'Northwind Office Supplies' }, TxnDate: '2026-09-01', DueDate: '2026-10-01', TotalAmt: 1302, Balance: 1302, CurrencyRef: { value: 'USD' } }],
    PurchaseOrder: [],
  };
  return serve(({ req, url, body, raw }) => {
    log.push({ method: req.method, path: url.pathname, query: url.searchParams.get('query'), body, auth: req.headers.authorization, minor: url.searchParams.get('minorversion'), ctype: req.headers['content-type'], raw });
    if (url.pathname === '/oauth2/v1/tokens/bearer') return { json: { access_token: 'qbo-at-' + log.length, refresh_token: 'qbo-rt', expires_in: 3600 } };
    const m = url.pathname.match(/^\/v3\/company\/(\w+)\/(\w+)(?:\/(\w+))?$/);
    if (!m) return { status: 404 };
    if (!String(req.headers.authorization || '').startsWith('Bearer qbo-at-')) return { status: 401, json: { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } } };
    const [, , entity] = m;
    if (entity === 'companyinfo') return { json: { CompanyInfo: { CompanyName: 'Sandbox Company_US_1', Country: 'US' } } };
    if (entity === 'query') {
      const sql = url.searchParams.get('query');
      const ent = sql.match(/from (\w+)/i)[1];
      let rows = db[ent] || [];
      const dn = sql.match(/DocNumber = '(.+?)'/); if (dn) rows = rows.filter((r) => r.DocNumber === dn[1].replace(/\\'/g, "'"));
      if (/Balance > '0'/.test(sql)) rows = rows.filter((r) => r.Balance > 0);
      const start = Number(sql.match(/STARTPOSITION (\d+)/)?.[1] || 1);
      return { json: { QueryResponse: start > 1 ? {} : { [ent]: rows } } };
    }
    if (entity === 'vendor' && req.method === 'POST') { const v = { Id: String(100 + db.Vendor.length), ...body, Active: true }; db.Vendor.push(v); return { json: { Vendor: v } }; }
    if (entity === 'bill' && req.method === 'POST') {
      if (!body.VendorRef?.value || !body.Line?.length) return { status: 400, json: { Fault: { Error: [{ Message: 'Required param missing', Detail: 'VendorRef' }] } } };
      const total = body.Line.reduce((s, l) => s + l.Amount, 0);
      const b = { Id: String(200 + db.Bill.length), ...body, TotalAmt: Math.round(total * 100) / 100, Balance: total };
      db.Bill.push(b); return { json: { Bill: b } };
    }
    if (entity === 'upload') return { json: { AttachableResponse: [{ Attachable: { Id: '9' } }] } };
    return { status: 404 };
  });
}

// --- Xero: just enough of Accounting API 2.0
export function xeroMock(log = []) {
  const db = {
    Contacts: [{ ContactID: 'c-1', Name: 'Peak IT Services', ContactStatus: 'ACTIVE', IsSupplier: true }],
    Accounts: [{ Code: '429', Name: 'General Expenses', Class: 'EXPENSE', Type: 'EXPENSE', Status: 'ACTIVE', TaxType: 'INPUT' }, { Code: '090', Name: 'Bank', Class: 'ASSET', Type: 'BANK', Status: 'ACTIVE' }],
    TaxRates: [{ Name: 'GST on Expenses', TaxType: 'INPUT', EffectiveRate: 5, Status: 'ACTIVE', CanApplyToExpenses: true }],
    Invoices: [{ InvoiceID: 'i-1', Type: 'ACCPAY', InvoiceNumber: 'PIT-5512', Contact: { ContactID: 'c-1', Name: 'Peak IT Services' }, DateString: '2026-10-01T00:00:00', DueDateString: '2026-10-31T00:00:00', Total: 3018.75, AmountDue: 3018.75, Status: 'AUTHORISED', CurrencyCode: 'CAD' }],
    PurchaseOrders: [{ PurchaseOrderID: 'p-1', PurchaseOrderNumber: 'PO-1007', Contact: { ContactID: 'c-1', Name: 'Peak IT Services' }, DateString: '2026-10-30T00:00:00', Total: 4410, Status: 'AUTHORISED' }],
  };
  return serve(({ req, url, body }) => {
    log.push({ method: req.method, path: url.pathname, search: url.search, body, auth: req.headers.authorization, tenant: req.headers['xero-tenant-id'], ctype: req.headers['content-type'] });
    if (url.pathname === '/connect/token') return { json: { access_token: 'xero-at', refresh_token: 'xero-rt', expires_in: 1800 } };
    if (url.pathname === '/connections') return { json: [{ tenantId: 't-123', tenantName: 'Demo Company (CA)', tenantType: 'ORGANISATION' }] };
    if (req.headers['xero-tenant-id'] !== 't-123') return { status: 403, json: { Title: 'Forbidden', Detail: 'tenant' } };
    const p = url.pathname.replace('/api.xro/2.0', '');
    const page = Number(url.searchParams.get('page') || 1);
    if (p === '/Organisation') return { json: { Organisations: [{ Name: 'Demo Company (CA)', CountryCode: 'CA', BaseCurrency: 'CAD' }] } };
    if (p === '/Contacts' && req.method === 'GET') return { json: { Contacts: page > 1 ? [] : db.Contacts } };
    if (p === '/Accounts') return { json: { Accounts: db.Accounts } };
    if (p === '/TaxRates') return { json: { TaxRates: db.TaxRates } };
    if (p === '/PurchaseOrders') return { json: { PurchaseOrders: page > 1 ? [] : db.PurchaseOrders } };
    if (p === '/Invoices' && req.method === 'GET') {
      const where = url.searchParams.get('where') || '';
      let rows = db.Invoices; const n = where.match(/InvoiceNumber=="(.+?)"/); if (n) rows = rows.filter((r) => r.InvoiceNumber === n[1]);
      return { json: { Invoices: page > 1 ? [] : rows } };
    }
    if (p === '/Invoices' && req.method === 'POST') {
      const inv = body.Invoices[0];
      if (!inv.LineItems.every((l) => l.AccountCode)) return { status: 400, json: { Elements: [{ ValidationErrors: [{ Message: 'Account code required' }] }] } };
      const sub = inv.LineItems.reduce((s, l) => s + l.UnitAmount * l.Quantity, 0);
      const tax = inv.LineItems.reduce((s, l) => s + (l.TaxType === 'INPUT' ? l.UnitAmount * 0.05 : 0), 0);
      const saved = { ...inv, InvoiceID: 'i-new', Total: Math.round((sub + tax) * 100) / 100, TotalTax: Math.round(tax * 100) / 100, AmountDue: sub + tax };
      db.Invoices.push(saved); return { json: { Invoices: [saved] } };
    }
    if (/^\/Invoices\/[\w-]+\/Attachments\//.test(p) && req.method === 'PUT') return { json: { Attachments: [{ AttachmentID: 'a-1' }] } };
    return { status: 404, json: { Message: 'nope ' + p } };
  });
}
