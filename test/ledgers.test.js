import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDataDir, startApp } from './helpers.js';
import { qboMock, xeroMock } from './mocks.js';

freshDataDir('ledgers');
const qLog = [], xLog = [];
const Q = await qboMock(qLog), X = await xeroMock(xLog);
Object.assign(process.env, {
  QBO_API_BASE: Q.url, QBO_TOKEN_URL: `${Q.url}/oauth2/v1/tokens/bearer`, QBO_CLIENT_ID: 'qid', QBO_CLIENT_SECRET: 'qsecret',
  XERO_API_BASE: X.url, XERO_TOKEN_URL: `${X.url}/connect/token`, XERO_CLIENT_ID: 'xid', XERO_CLIENT_SECRET: 'xsecret',
});
const app = await startApp();
const store = await import('../src/store.js');
after(() => { app.close(); Q.close(); X.close(); });

const settings = (o) => app.j('/api/settings', { method: 'POST', body: JSON.stringify(o) });
const oauthState = async (ledger) => {
  const r = await fetch(`${app.base}/oauth/${ledger}/start`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  return loc;
};

test('QuickBooks: OAuth start sends the right authorize request', async () => {
  const loc = await oauthState('qbo');
  assert.equal(loc.origin + loc.pathname, 'https://appcenter.intuit.com/connect/oauth2');
  assert.equal(loc.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://localhost:8787/oauth/qbo/callback');
  // callback exchanges the code (Basic auth with client id/secret) and switches the ledger
  const cb = await fetch(`${app.base}/oauth/qbo/callback?code=abc&realmId=4620816365&state=${loc.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const tok = qLog.find((l) => l.path === '/oauth2/v1/tokens/bearer');
  assert.equal(tok.auth, 'Basic ' + Buffer.from('qid:qsecret').toString('base64'));
  assert.match(tok.raw.toString(), /grant_type=authorization_code/);
  const st = (await app.j('/api/status')).body;
  assert.equal(st.ledger.key, 'qbo');
  assert.equal(st.ledger.company, 'Sandbox Company_US_1');
});

test('QuickBooks: a replayed or forged state is refused', async () => {
  const r = await fetch(`${app.base}/oauth/qbo/callback?code=abc&realmId=1&state=forged`);
  assert.equal(r.status, 400);
});

test('QuickBooks: expired token is refreshed, vendors/accounts are read, duplicates found', async () => {
  store.setTokens('qbo', { access_token: 'old', expires_at: 0 });
  const { runTool } = await import('../src/tools.js');
  const v = await runTool('search_vendors', { query: 'northwind' });
  assert.equal(v.matches[0].id, '56');
  assert.ok(qLog.some((l) => l.path === '/oauth2/v1/tokens/bearer' && /grant_type=refresh_token/.test(l.raw.toString())));
  const acc = await runTool('list_accounts');
  assert.deepEqual(acc.accounts.map((a) => a.name), ['Office Supplies']); // bank accounts excluded
  assert.ok(qLog.every((l) => !l.path.startsWith('/v3') || l.minor === '75'));
  const dup = await runTool('check_invoice', { vendor_name: 'Northwind Office Supplies', invoice_number: 'INV-10391', invoice_date: '2026-09-01', lines: [{ description: 'x', amount: 1240, account_id: '7' }], tax: 62, total: 1302 });
  assert.ok(dup.findings.some((f) => f.code === 'duplicate'));
});

test('QuickBooks: approved bill is created with expense lines, tax as its own line (US), and the PDF attached', async () => {
  const { runTool } = await import('../src/tools.js');
  const p = await runTool('propose_bill', { vendor_name: 'Northwind Office Supplies', vendor_id: '56', invoice_number: 'INV-10458', invoice_date: '2026-11-14', due_date: '2026-12-14', lines: [{ description: 'Paper', amount: 654, account_id: '7' }, { description: 'Toner', amount: 943.5, account_id: '7' }], tax: 79.88, total: 1677.38 });
  assert.equal(p.queued, true, JSON.stringify(p));
  const fs = await import('node:fs');
  const f = store.saveFile(fs.readFileSync(new URL('../samples/northwind-INV-10458.pdf', import.meta.url)), 'northwind.pdf', 'application/pdf');
  store.queueUpdate(p.id, { file: { id: f.sha, name: f.name, type: f.type } });
  const r = await app.j(`/api/queue/${p.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bill = qLog.find((l) => l.path.endsWith('/bill') && l.body?.VendorRef).body;
  assert.equal(bill.VendorRef.value, '56');
  assert.equal(bill.DocNumber, 'INV-10458');
  assert.equal(bill.Line.length, 3);
  assert.equal(bill.Line[0].DetailType, 'AccountBasedExpenseLineDetail');
  assert.equal(bill.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, '7');
  assert.equal(bill.Line[2].Amount, 79.88);
  assert.equal(r.body.posted.total, 1677.38);
  assert.match(r.body.posted.url, /sandbox\.qbo\.intuit\.com\/app\/bill\?txnId=/);
  const up = qLog.find((l) => l.path.endsWith('/upload'));
  assert.match(up.ctype, /multipart\/form-data/);
  assert.match(up.raw.toString('latin1'), /"EntityRef":\{"type":"Bill"/);
  assert.deepEqual(r.body.posted.warnings, []);
});

test('Xero: connect, read, and post an ACCPAY bill with granular scopes', async () => {
  const loc = await oauthState('xero');
  assert.equal(loc.origin + loc.pathname, 'https://login.xero.com/identity/connect/authorize');
  const scope = loc.searchParams.get('scope');
  assert.ok(scope.includes('accounting.invoices') && !scope.includes('accounting.transactions'));
  const cb = await fetch(`${app.base}/oauth/xero/callback?code=xyz&state=${loc.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const st = (await app.j('/api/status')).body;
  assert.equal(st.ledger.key, 'xero');
  assert.equal(st.ledger.company, 'Demo Company (CA)');

  const { runTool } = await import('../src/tools.js');
  const s = await runTool('ap_summary');
  assert.equal(s.openBills, 1);
  const dup = await runTool('check_invoice', { vendor_name: 'Peak IT Services', invoice_number: 'PIT-5512', invoice_date: '2026-10-01', lines: [{ description: 'x', amount: 2875, account_id: '429' }], tax: 143.75, total: 3018.75 });
  assert.ok(dup.findings.some((f) => f.code === 'duplicate'));
  const ok = { vendor_name: 'Peak IT Services', invoice_number: 'PIT-5601', invoice_date: '2026-11-16', due_date: '2026-12-16', po_number: 'PO-1007', currency: 'CAD', lines: [{ description: 'Laptops', amount: 4050, account_id: '429', tax_code: 'INPUT' }, { description: 'Setup', amount: 375, account_id: '429', tax_code: 'INPUT' }], tax: 221.25, total: 4646.25 };
  const c = await runTool('check_invoice', ok);
  assert.equal(c.result, 'pass', JSON.stringify(c.findings));
  const p = await runTool('propose_bill', ok);
  const r = await app.j(`/api/queue/${p.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const post = xLog.find((l) => l.method === 'POST' && l.path.endsWith('/Invoices')).body.Invoices[0];
  assert.equal(post.Type, 'ACCPAY');
  assert.equal(post.Contact.ContactID, 'c-1');
  assert.equal(post.LineAmountTypes, 'Exclusive');
  assert.equal(post.Status, 'AUTHORISED');
  assert.equal(post.LineItems[0].AccountCode, '429');
  assert.equal(post.LineItems[0].TaxType, 'INPUT');
  assert.ok(xLog.filter((l) => l.path.startsWith('/api.xro')).every((l) => l.tenant === 't-123'));
  assert.equal(r.body.posted.total, 4646.25);
  assert.deepEqual(r.body.posted.warnings, []);
});

test('a bill that fails the checks is never sent to Xero and stays pending', async () => {
  const { runTool } = await import('../src/tools.js');
  const p = await runTool('propose_bill', { vendor_name: 'Brand New Vendor', invoice_number: 'BNV-1', invoice_date: '2026-11-10', lines: [{ description: 'Thing', amount: 100, account_id: '429' }], tax: 5, total: 105 });
  const { queueUpdate, queueGet } = store;
  queueUpdate(p.id, { draft: { ...queueGet(p.id).draft, lines: [{ description: 'Thing', amount: 100, accountId: '' }] } });
  const r = await app.j(`/api/queue/${p.id}/approve`, { method: 'POST', body: JSON.stringify({ acknowledgeWarnings: true }) });
  assert.equal(r.status, 400);
  assert.equal(queueGet(p.id).status, 'pending');
  assert.ok(!xLog.some((l) => l.method === 'POST' && l.body?.Invoices?.[0]?.InvoiceNumber === 'BNV-1'));
});
