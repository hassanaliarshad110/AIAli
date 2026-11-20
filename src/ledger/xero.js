// Xero connector (Accounting API 2.0, OAuth 2.0 with the granular scopes Xero requires for apps created since March 2026).
// Create a "Web app" at developer.xero.com/app/manage, add the redirect URI shown in Settings, and paste the client id/secret.
import { get, publicUrl } from '../config.js';
import { tokens, setTokens } from '../store.js';
import { readJson, round2 } from '../util.js';

export const XERO_SCOPES = 'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read accounting.attachments';
const AUTH_URL = () => get('XERO_AUTH_URL') || 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = () => get('XERO_TOKEN_URL') || 'https://identity.xero.com/connect/token';
const API = () => get('XERO_API_BASE') || 'https://api.xero.com';
export const xeroRedirect = () => `${publicUrl()}/oauth/xero/callback`;
const basic = () => 'Basic ' + Buffer.from(`${get('XERO_CLIENT_ID')}:${get('XERO_CLIENT_SECRET')}`).toString('base64');

export function xeroAuthorizeUrl(state) {
  const u = new URL(AUTH_URL());
  u.search = new URLSearchParams({ response_type: 'code', client_id: get('XERO_CLIENT_ID'), redirect_uri: xeroRedirect(), scope: XERO_SCOPES, state }).toString();
  return u.toString();
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL(), { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body) });
  const j = await readJson(res);
  if (!res.ok) throw new Error(`Xero sign-in failed: ${j.error_description || j.error || res.status}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 1800) * 1000 - 60000 };
}

export async function xeroExchange(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: xeroRedirect() });
  const res = await fetch(`${API()}/connections`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } });
  const conns = await readJson(res);
  const org = Array.isArray(conns) ? conns.find((c) => c.tenantType === 'ORGANISATION') || conns[0] : null;
  if (!org) throw new Error('Xero sign-in worked, but no organisation was shared with this app.');
  setTokens('xero', { ...t, tenantId: org.tenantId, tenantName: org.tenantName, connected_at: new Date().toISOString() });
}

async function accessToken() {
  const t = tokens('xero');
  if (!t?.refresh_token) throw new Error('Xero is not connected. Open Settings and click "Connect Xero".');
  if (t.access_token && Date.now() < t.expires_at) return t;
  setTokens('xero', await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
  return tokens('xero');
}

function xeroError(j, status) {
  const v = j.Elements?.flatMap((e) => (e.ValidationErrors || []).map((x) => x.Message)) || [];
  return `Xero: ${v.length ? v.join('; ') : j.Detail || j.Message || j.Title || `HTTP ${status}`}`;
}
async function call(method, path, body, headers = {}) {
  const t = await accessToken();
  const res = await fetch(`${API()}/api.xro/2.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${t.access_token}`, 'xero-tenant-id': t.tenantId, Accept: 'application/json', ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
  });
  const j = await readJson(res);
  if (!res.ok) throw new Error(xeroError(j, res.status));
  return j;
}
async function pages(path, key) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const j = await call('GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=1000`);
    const rows = j[key] || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const day = (s) => (s ? String(s).slice(0, 10) : '');
const bill = (b) => ({
  id: b.InvoiceID, vendorId: b.Contact?.ContactID, vendorName: b.Contact?.Name, number: b.InvoiceNumber || '', date: day(b.DateString), dueDate: day(b.DueDateString || b.DateString),
  currency: b.CurrencyCode || '', total: Number(b.Total || 0), balance: Number(b.AmountDue || 0), status: b.Status === 'PAID' ? 'Paid' : b.Status === 'DRAFT' ? 'Draft' : Number(b.AmountDue) > 0 ? 'Open' : 'Paid',
});
const esc = (s) => String(s).replace(/"/g, '\\"');

export const xero = {
  key: 'xero',
  label: 'Xero',
  async info() {
    const t = tokens('xero');
    if (!t?.refresh_token) return { ledger: 'xero', connected: false };
    try {
      const j = await call('GET', '/Organisation');
      const o = j.Organisations?.[0] || {};
      return { ledger: 'xero', connected: true, company: o.Name || t.tenantName, country: o.CountryCode, currency: o.BaseCurrency };
    } catch (e) { return { ledger: 'xero', connected: false, company: t.tenantName, error: e.message }; }
  },
  async listVendors() {
    return (await pages(`/Contacts?where=${encodeURIComponent('ContactStatus=="ACTIVE"')}&summaryOnly=true`, 'Contacts'))
      .map((c) => ({ id: c.ContactID, name: c.Name, email: c.EmailAddress || '', currency: c.DefaultCurrency || '', supplier: !!c.IsSupplier }));
  },
  async createVendor({ name, email }) {
    const j = await call('POST', '/Contacts', { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] });
    const c = j.Contacts[0];
    return { id: c.ContactID, name: c.Name, email: c.EmailAddress || '' };
  },
  async listAccounts() {
    const j = await call('GET', `/Accounts?where=${encodeURIComponent('Status=="ACTIVE"')}`);
    return (j.Accounts || []).filter((a) => ['EXPENSE', 'ASSET'].includes(a.Class) && a.Type !== 'BANK' && a.Code)
      .map((a) => ({ id: a.Code, code: a.Code, name: a.Name, type: a.Type, defaultTax: a.TaxType || '' }));
  },
  async listTaxCodes() {
    const j = await call('GET', '/TaxRates');
    return (j.TaxRates || []).filter((t) => t.Status === 'ACTIVE' && t.CanApplyToExpenses !== false)
      .map((t) => ({ id: t.TaxType, name: t.Name, rate: Number(t.EffectiveRate ?? t.DisplayTaxRate ?? 0) }));
  },
  async listBills({ openOnly = false } = {}) {
    const where = openOnly ? 'Type=="ACCPAY" AND AmountDue>0' : 'Type=="ACCPAY"';
    const statuses = openOnly ? '&Statuses=AUTHORISED,SUBMITTED' : '&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID';
    return (await pages(`/Invoices?where=${encodeURIComponent(where)}${statuses}&order=Date%20DESC`, 'Invoices')).map(bill);
  },
  async findBillsByNumber(number) {
    const where = `Type=="ACCPAY" AND InvoiceNumber=="${esc(number)}"`;
    return ((await call('GET', `/Invoices?where=${encodeURIComponent(where)}`)).Invoices || []).filter((b) => b.Status !== 'DELETED' && b.Status !== 'VOIDED').map(bill);
  },
  async listPurchaseOrders() {
    return (await pages('/PurchaseOrders?status=AUTHORISED', 'PurchaseOrders')).map((p) => ({
      id: p.PurchaseOrderID, number: p.PurchaseOrderNumber, vendorId: p.Contact?.ContactID, vendorName: p.Contact?.Name, date: day(p.DateString), total: Number(p.Total || 0), status: 'Open',
    }));
  },
  async createBill(draft, file) {
    const warnings = [];
    const status = get('XERO_BILL_STATUS') === 'DRAFT' ? 'DRAFT' : 'AUTHORISED';
    const inv = {
      Type: 'ACCPAY', Contact: draft.vendor.id ? { ContactID: draft.vendor.id } : { Name: draft.vendor.name }, Date: draft.date, DueDate: draft.dueDate,
      InvoiceNumber: String(draft.number), ...(draft.currency ? { CurrencyCode: draft.currency } : {}), LineAmountTypes: 'Exclusive', Status: status,
      ...(draft.poNumber ? { Reference: `PO ${draft.poNumber}` } : {}),
      LineItems: draft.lines.map((l) => ({ Description: l.description || 'Invoice line', Quantity: 1, UnitAmount: round2(l.amount), AccountCode: l.accountId, ...(l.taxCode ? { TaxType: l.taxCode } : {}) })),
    };
    const j = await call('POST', '/Invoices?summarizeErrors=false', { Invoices: [inv] });
    const b = j.Invoices?.[0];
    if (!b || b.HasErrors || b.StatusAttributeString === 'ERROR') throw new Error(`Xero: ${(b?.ValidationErrors || []).map((e) => e.Message).join('; ') || 'the bill was not accepted'}`);
    if (Math.abs(Number(b.Total) - draft.total) > 0.02) warnings.push(`Xero calculated a total of ${b.Total}, the invoice says ${draft.total}. Check the tax rates on this bill.`);
    if (file) {
      try { await call('PUT', `/Invoices/${b.InvoiceID}/Attachments/${encodeURIComponent(file.name)}`, Buffer.from(file.data), { 'Content-Type': file.type }); }
      catch (e) { warnings.push(`Bill posted, but attaching the invoice file failed: ${e.message}`); }
    }
    return { id: b.InvoiceID, url: `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${b.InvoiceID}`, total: Number(b.Total), tax: Number(b.TotalTax || 0), status, warnings };
  },
};
