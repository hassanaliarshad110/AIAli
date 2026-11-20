import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshDataDir, startApp } from './helpers.js';
import { zohoMock } from './mocks.js';

freshDataDir('zoho');
const log = [];
const Z = await zohoMock(log);
Object.assign(process.env, { ZOHO_CLIENT_ID: '1000.zid', ZOHO_CLIENT_SECRET: 'zsecret', ZOHO_ACCOUNTS_URL: Z.url, ZOHO_ALLOW_TEST_HOSTS: 'true' });
const app = await startApp();
const store = await import('../src/store.js');
after(() => { app.close(); Z.close(); });

test('Zoho Books: sign-in follows the user\'s data centre and picks the default organisation', async () => {
  const r = await fetch(`${app.base}/oauth/zoho/start`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.pathname, '/oauth/v2/auth');
  assert.equal(loc.searchParams.get('access_type'), 'offline');
  assert.match(loc.searchParams.get('scope'), /ZohoBooks\.bills\.ALL/);
  const cb = await fetch(`${app.base}/oauth/zoho/callback?code=abc&location=eu&accounts-server=${encodeURIComponent(Z.url)}&state=${loc.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const tok = log.find((l) => l.path === '/oauth/v2/token');
  assert.match(tok.raw.toString(), /grant_type=authorization_code/);
  assert.match(tok.raw.toString(), /client_secret=zsecret/);
  const st = (await app.j('/api/status')).body;
  assert.equal(st.ledger.key, 'zoho');
  assert.equal(st.ledger.company, 'Maple Ridge FZ-LLC');
  assert.equal(st.ledger.currency, 'AED');
});

test('Zoho Books: credentials are never sent to a non-Zoho server', async () => {
  delete process.env.ZOHO_ALLOW_TEST_HOSTS;
  const r = await fetch(`${app.base}/oauth/zoho/start`, { redirect: 'manual' });
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  const before = log.length;
  const cb = await fetch(`${app.base}/oauth/zoho/callback?code=abc&accounts-server=${encodeURIComponent('https://evil.example')}&state=${state}`);
  assert.equal(cb.status, 400);
  assert.match(await cb.text(), /unknown server/);
  assert.equal(log.length, before);
  process.env.ZOHO_ALLOW_TEST_HOSTS = 'true';
});

test('Zoho Books: reads vendors, accounts, VAT, bills; finds duplicates; posts a bill with the PDF', async () => {
  const { runTool } = await import('../src/tools.js');
  const acc = await runTool('list_accounts');
  assert.deepEqual(acc.accounts.map((a) => a.name), ['IT and Internet Expenses']);
  assert.equal(acc.tax_codes[0].rate, 5);
  assert.equal((await runTool('ap_summary')).overdue, 3018.75);
  const dup = await runTool('check_invoice', { vendor_name: 'Peak IT Services', invoice_number: 'PIT-5512', invoice_date: '2026-10-01', lines: [{ description: 'x', amount: 2875, account_id: 'z-a1' }], tax: 143.75, total: 3018.75 });
  assert.ok(dup.findings.some((f) => f.code === 'duplicate'));
  const inv = { vendor_name: 'Peak IT Services', invoice_number: 'PIT-5601', invoice_date: '2026-11-16', due_date: '2026-12-16', po_number: 'PO-1007', currency: 'AED', lines: [{ description: 'Laptops', amount: 4050, account_id: '6200', tax_code: 'z-t5' }, { description: 'Setup', amount: 375, account_id: 'z-a1', tax_code: 'z-t5' }], tax: 221.25, total: 4646.25 };
  const c = await runTool('check_invoice', inv);
  assert.equal(c.result, 'pass', JSON.stringify(c.findings)); // account code 6200 resolves to the Zoho account id
  const p = await runTool('propose_bill', inv);
  const f = store.saveFile(fs.readFileSync(new URL('../samples/peakit-PIT-5601.pdf', import.meta.url)), 'peakit.pdf', 'application/pdf');
  store.queueUpdate(p.id, { file: { id: f.sha, name: f.name, type: f.type } });
  const r = await app.j(`/api/queue/${p.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const post = log.find((l) => l.method === 'POST' && l.path === '/books/v3/bills').body;
  assert.equal(post.vendor_id, 'z-v1');
  assert.equal(post.bill_number, 'PIT-5601');
  assert.equal(post.line_items[0].account_id, 'z-a1');
  assert.equal(post.line_items[0].tax_id, 'z-t5');
  assert.equal(post.is_inclusive_tax, false);
  assert.ok(log.filter((l) => l.path.startsWith('/books/v3') && l.path !== '/books/v3/organizations').every((l) => l.search.includes('organization_id=999')));
  const att = log.find((l) => l.path.endsWith('/attachment'));
  assert.match(att.ctype, /multipart\/form-data/);
  assert.equal(r.body.posted.total, 4646.25);
  assert.deepEqual(r.body.posted.warnings, []);
});

test('Zoho Books: expired access token is refreshed at the same data centre', async () => {
  store.setTokens('zoho', { access_token: 'old', expires_at: 0 });
  const { clearCache } = await import('../src/ledger/index.js'); clearCache();
  const n = log.filter((l) => l.path === '/oauth/v2/token').length;
  const { runTool } = await import('../src/tools.js');
  await runTool('search_vendors', { query: 'peak' });
  const t = log.filter((l) => l.path === '/oauth/v2/token');
  assert.equal(t.length, n + 1);
  assert.match(t.at(-1).raw.toString(), /grant_type=refresh_token/);
});
