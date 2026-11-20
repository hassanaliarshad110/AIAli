// Zoho Books connector (API v3, OAuth 2.0, multi data centre).
// Setup: api-console.zoho.com → Server-based Applications → add the redirect URI from Settings → paste client id/secret.
// Turn on "Multi-DC" for the client if your Zoho Books is not on zoho.com (EU, India, Australia, Japan, Canada, Saudi Arabia, UK, China).
import { get, publicUrl } from '../config.js';
import { tokens, setTokens } from '../store.js';
import { readJson, round2 } from '../util.js';

export const ZOHO_SCOPES = 'ZohoBooks.bills.ALL,ZohoBooks.contacts.ALL,ZohoBooks.purchaseorders.READ,ZohoBooks.settings.READ,ZohoBooks.accountants.READ';
const START_ACCOUNTS = () => get('ZOHO_ACCOUNTS_URL') || 'https://accounts.zoho.com';
// Only send credentials to genuine Zoho servers, whatever the sign-in redirect says.
const ACCOUNTS_OK = /^https:\/\/accounts\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|com\.cn)|zohocloud\.ca)$/;
const API_OK = /^https:\/\/www\.zohoapis\.(com|eu|in|com\.au|jp|ca|sa|uk|com\.cn)$/;
const trusted = (url, re) => (get('ZOHO_ALLOW_TEST_HOSTS') === 'true' && /^http:\/\/127\.0\.0\.1:\d+$/.test(url)) || re.test(url);
export const zohoRedirect = () => `${publicUrl()}/oauth/zoho/callback`;

export function zohoAuthorizeUrl(state) {
  const u = new URL(`${START_ACCOUNTS()}/oauth/v2/auth`);
  u.search = new URLSearchParams({ client_id: get('ZOHO_CLIENT_ID'), response_type: 'code', redirect_uri: zohoRedirect(), scope: ZOHO_SCOPES, access_type: 'offline', prompt: 'consent', state }).toString();
  return u.toString();
}

async function tokenRequest(accounts, body) {
  if (!trusted(accounts, ACCOUNTS_OK)) throw new Error(`Refusing to sign in to an unknown server: ${accounts}`);
  const res = await fetch(`${accounts}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: get('ZOHO_CLIENT_ID'), client_secret: get('ZOHO_CLIENT_SECRET'), ...body }) });
  const j = await readJson(res);
  if (!res.ok || j.error) throw new Error(`Zoho sign-in failed: ${j.error || res.status}${j.error === 'invalid_client' ? ' (if your Zoho is outside zoho.com, enable Multi-DC for this client in the Zoho API console)' : ''}`);
  return { access_token: j.access_token, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), ...(j.api_domain ? { apiDomain: j.api_domain } : {}), expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
}

// Zoho sends the user's own accounts server back on the callback (accounts-server), e.g. https://accounts.zoho.eu.
export async function zohoExchange(code, accountsServer) {
  const accounts = accountsServer || START_ACCOUNTS();
  const t = await tokenRequest(accounts, { grant_type: 'authorization_code', code, redirect_uri: zohoRedirect() });
  if (!t.refresh_token) throw new Error('Zoho did not return a refresh token. Remove the app under Zoho Accounts → Connected apps and connect again.');
  if (!t.apiDomain || !trusted(t.apiDomain, API_OK)) throw new Error(`Unexpected Zoho API domain: ${t.apiDomain}`);
  setTokens('zoho', { ...t, accounts, connected_at: new Date().toISOString() });
  const orgs = (await call('GET', '/organizations', null, { noOrg: true })).organizations || [];
  const want = get('ZOHO_ORGANIZATION_ID');
  const org = orgs.find((o) => o.organization_id === want) || orgs.find((o) => o.is_default_org) || orgs[0];
  if (!org) throw new Error('No Zoho Books organisation found on this account.');
  setTokens('zoho', { orgId: org.organization_id, orgName: org.name, currency: org.currency_code });
}

async function accessToken() {
  const t = tokens('zoho');
  if (!t?.refresh_token) throw new Error('Zoho Books is not connected. Open Settings and click "Connect Zoho Books".');
  if (t.access_token && Date.now() < t.expires_at) return t;
  setTokens('zoho', await tokenRequest(t.accounts, { grant_type: 'refresh_token', refresh_token: t.refresh_token }));
  return tokens('zoho');
}

async function call(method, path, body, { noOrg = false, form } = {}) {
  const t = await accessToken();
  const orgId = get('ZOHO_ORGANIZATION_ID') || t.orgId;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${t.apiDomain}/books/v3${path}${noOrg ? '' : `${sep}organization_id=${encodeURIComponent(orgId)}`}`;
  const res = await fetch(url, {
    method, headers: { Authorization: `Zoho-oauthtoken ${t.access_token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const j = await readJson(res);
  if (!res.ok || (j.code != null && j.code !== 0)) throw new Error(`Zoho Books: ${j.message || `HTTP ${res.status}`}`);
  return j;
}
async function pages(path, key) {
  const out = [];
  for (let page = 1; page <= 25; page++) {
    const j = await call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=200`);
    out.push(...(j[key] || []));
    if (!j.page_context?.has_more_page) break;
  }
  return out;
}

const OPEN = new Set(['open', 'overdue', 'partially_paid', 'unpaid']);
const bill = (b) => ({
  id: b.bill_id, vendorId: b.vendor_id, vendorName: b.vendor_name, number: b.bill_number || '', date: b.date, dueDate: b.due_date || b.date,
  currency: b.currency_code || '', total: Number(b.total || 0), balance: Number(b.balance || 0),
  status: b.status === 'draft' ? 'Draft' : b.status === 'paid' ? 'Paid' : OPEN.has(b.status) || Number(b.balance) > 0 ? 'Open' : b.status,
});

export const zoho = {
  key: 'zoho',
  label: 'Zoho Books',
  async info() {
    const t = tokens('zoho');
    if (!t?.refresh_token) return { ledger: 'zoho', connected: false };
    try {
      const j = await call('GET', '/organizations', null, { noOrg: true });
      const o = (j.organizations || []).find((x) => x.organization_id === (get('ZOHO_ORGANIZATION_ID') || t.orgId)) || {};
      return { ledger: 'zoho', connected: true, company: o.name || t.orgName, currency: o.currency_code || t.currency, country: o.country };
    } catch (e) { return { ledger: 'zoho', connected: false, company: t.orgName, error: e.message }; }
  },
  async listVendors() {
    return (await pages('/contacts?contact_type=vendor&filter_by=Status.Active', 'contacts'))
      .map((c) => ({ id: c.contact_id, name: c.contact_name, email: c.email || '', currency: c.currency_code || '' }));
  },
  async createVendor({ name, email }) {
    const j = await call('POST', '/contacts', { contact_name: name.slice(0, 200), contact_type: 'vendor', ...(email ? { contact_persons: [{ email, is_primary_contact: true }] } : {}) });
    return { id: j.contact.contact_id, name: j.contact.contact_name, email: email || '' };
  },
  async listAccounts() {
    const ok = new Set(['expense', 'other_expense', 'cost_of_goods_sold', 'fixed_asset', 'other_current_asset']);
    return ((await call('GET', '/chartofaccounts?filter_by=AccountType.Active')).chartofaccounts || [])
      .filter((a) => ok.has(a.account_type) && a.is_active !== false)
      .map((a) => ({ id: a.account_id, code: a.account_code || '', name: a.account_name, type: a.account_type }));
  },
  async listTaxCodes() {
    try {
      return ((await call('GET', '/settings/taxes')).taxes || []).filter((t) => t.tax_type !== 'tax_group' || true)
        .map((t) => ({ id: t.tax_id, name: t.tax_name, rate: Number(t.tax_percentage || 0) }));
    } catch { return []; }
  },
  async listBills({ openOnly = false } = {}) {
    const rows = (await pages('/bills?sort_column=date&sort_order=D', 'bills')).map(bill).filter((b) => b.status !== 'void');
    return openOnly ? rows.filter((b) => b.balance > 0.005 && b.status !== 'Draft') : rows;
  },
  async findBillsByNumber(number) {
    return ((await call('GET', `/bills?bill_number=${encodeURIComponent(number)}`)).bills || []).map(bill).filter((b) => b.status !== 'void');
  },
  async listPurchaseOrders() {
    try {
      return (await pages('/purchaseorders?filter_by=Status.Open', 'purchaseorders')).map((p) => ({
        id: p.purchaseorder_id, number: p.purchaseorder_number, vendorId: p.vendor_id, vendorName: p.vendor_name, date: p.date, total: Number(p.total || 0), status: 'Open',
      }));
    } catch { return []; }
  },
  async createBill(draft, file) {
    const warnings = [];
    let vendorId = draft.vendor.id;
    if (!vendorId) vendorId = (await this.createVendor(draft.vendor)).id;
    const body = {
      vendor_id: vendorId, bill_number: String(draft.number).slice(0, 100), date: draft.date, due_date: draft.dueDate, is_inclusive_tax: false,
      ...(draft.currency ? { currency_code: draft.currency } : {}),
      ...(draft.poNumber ? { reference_number: `PO ${draft.poNumber}` } : {}),
      notes: 'Posted by AI Ali after approval',
      line_items: draft.lines.map((l) => ({ account_id: l.accountId, description: (l.description || '').slice(0, 2000), rate: round2(l.amount), quantity: 1, ...(l.taxCode ? { tax_id: l.taxCode } : {}) })),
    };
    // Without tax ids, record the invoice's tax as its own line so the bill total matches the invoice.
    if (!draft.lines.some((l) => l.taxCode) && draft.tax > 0.005) body.line_items.push({ account_id: draft.lines[0].accountId, description: 'Tax as shown on the invoice', rate: round2(draft.tax), quantity: 1 });
    const j = await call('POST', '/bills', body);
    const b = j.bill;
    if (Math.abs(Number(b.total) - draft.total) > 0.02) warnings.push(`Zoho Books calculated a total of ${b.total}, the invoice says ${draft.total}. Check the taxes on this bill.`);
    if (file) {
      try {
        const fd = new FormData();
        fd.append('attachment', new Blob([file.data], { type: file.type }), file.name);
        await call('POST', `/bills/${b.bill_id}/attachment`, null, { form: fd });
      } catch (e) { warnings.push(`Bill posted, but attaching the invoice file failed: ${e.message}`); }
    }
    const t = tokens('zoho');
    const web = (t.apiDomain || '').replace('www.zohoapis.', 'books.zoho.').replace('books.zoho.ca', 'books.zohocloud.ca');
    return { id: b.bill_id, url: `${web}/app/${t.orgId}#/bills/${b.bill_id}`, total: Number(b.total), tax: Number(b.tax_total || 0), warnings };
  },
};
