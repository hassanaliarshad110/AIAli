// QuickBooks Online connector (Accounting API v3, OAuth 2.0).
// Create an app at developer.intuit.com, add the redirect URI shown in Settings, and paste the client id/secret.
import { get, publicUrl } from '../config.js';
import { tokens, setTokens } from '../store.js';
import { readJson, round2 } from '../util.js';

const MINOR = 75;
const AUTH_URL = () => get('QBO_AUTH_URL') || 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = () => get('QBO_TOKEN_URL') || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API = () => get('QBO_API_BASE') || (get('QBO_ENVIRONMENT') === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');
const APP = () => (get('QBO_ENVIRONMENT') === 'production' ? 'https://qbo.intuit.com' : 'https://sandbox.qbo.intuit.com');
export const qboRedirect = () => `${publicUrl()}/oauth/qbo/callback`;
const basic = () => 'Basic ' + Buffer.from(`${get('QBO_CLIENT_ID')}:${get('QBO_CLIENT_SECRET')}`).toString('base64');

export function qboAuthorizeUrl(state) {
  const u = new URL(AUTH_URL());
  u.search = new URLSearchParams({ client_id: get('QBO_CLIENT_ID'), response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: qboRedirect(), state }).toString();
  return u.toString();
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL(), { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body) });
  const j = await readJson(res);
  if (!res.ok) throw new Error(`QuickBooks sign-in failed: ${j.error_description || j.error || res.status}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
}

export async function qboExchange(code, realmId) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: qboRedirect() });
  setTokens('qbo', { ...t, realmId, connected_at: new Date().toISOString() });
}

async function accessToken() {
  const t = tokens('qbo');
  if (!t?.refresh_token) throw new Error('QuickBooks is not connected. Open Settings and click "Connect QuickBooks".');
  if (t.access_token && Date.now() < t.expires_at) return t;
  setTokens('qbo', await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
  return tokens('qbo');
}

async function call(method, path, body, extraHeaders = {}) {
  const t = await accessToken();
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API()}/v3/company/${t.realmId}${path}${sep}minorversion=${MINOR}`, {
    method, headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json', ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const j = await readJson(res);
  if (!res.ok || j.Fault) {
    const e = j.Fault?.Error?.[0];
    throw new Error(`QuickBooks: ${e ? `${e.Message}${e.Detail ? ` (${e.Detail})` : ''}` : `HTTP ${res.status}`}`);
  }
  return j;
}
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function query(sql, entity) {
  const out = [];
  for (let start = 1; start < 10000; start += 1000) {
    const j = await call('GET', `/query?query=${encodeURIComponent(`${sql} STARTPOSITION ${start} MAXRESULTS 1000`)}`);
    const rows = j.QueryResponse?.[entity] || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const bill = (b) => ({
  id: b.Id, vendorId: b.VendorRef?.value, vendorName: b.VendorRef?.name, number: b.DocNumber || '', date: b.TxnDate, dueDate: b.DueDate || b.TxnDate,
  currency: b.CurrencyRef?.value || '', total: Number(b.TotalAmt || 0), balance: Number(b.Balance || 0), status: Number(b.Balance) > 0 ? 'Open' : 'Paid',
});

export const qbo = {
  key: 'qbo',
  label: 'QuickBooks Online',
  async info() {
    const t = tokens('qbo');
    if (!t?.refresh_token) return { ledger: 'qbo', connected: false };
    try {
      const j = await call('GET', `/companyinfo/${t.realmId}`);
      const c = j.CompanyInfo || {};
      return { ledger: 'qbo', connected: true, company: c.CompanyName, country: c.Country, environment: get('QBO_ENVIRONMENT') };
    } catch (e) { return { ledger: 'qbo', connected: false, error: e.message }; }
  },
  async listVendors() {
    return (await query('select * from Vendor where Active = true', 'Vendor'))
      .map((v) => ({ id: v.Id, name: v.DisplayName, email: v.PrimaryEmailAddr?.Address || '', currency: v.CurrencyRef?.value || '' }));
  },
  async createVendor({ name, email }) {
    const j = await call('POST', '/vendor', { DisplayName: name.slice(0, 100), ...(email ? { PrimaryEmailAddr: { Address: email } } : {}) });
    return { id: j.Vendor.Id, name: j.Vendor.DisplayName, email: email || '' };
  },
  async listAccounts() {
    const ok = new Set(['Expense', 'Other Expense', 'Cost of Goods Sold', 'Fixed Asset', 'Other Current Asset']);
    return (await query('select * from Account where Active = true', 'Account'))
      .filter((a) => ok.has(a.AccountType))
      .map((a) => ({ id: a.Id, code: a.AcctNum || '', name: a.FullyQualifiedName || a.Name, type: a.AccountType }));
  },
  async listTaxCodes() {
    try {
      return (await query('select * from TaxCode where Active = true', 'TaxCode')).map((t) => ({ id: t.Id, name: t.Name, rate: null, description: t.Description || '' }));
    } catch { return []; }
  },
  async listBills({ openOnly = false } = {}) {
    return (await query(`select * from Bill${openOnly ? " where Balance > '0'" : ''} ORDERBY TxnDate DESC`, 'Bill')).map(bill);
  },
  async findBillsByNumber(number) {
    return (await query(`select * from Bill where DocNumber = '${q(number)}'`, 'Bill')).map(bill);
  },
  async listPurchaseOrders() {
    return (await query("select * from PurchaseOrder where POStatus = 'Open'", 'PurchaseOrder')).map((p) => ({
      id: p.Id, number: p.DocNumber || p.Id, vendorId: p.VendorRef?.value, vendorName: p.VendorRef?.name, date: p.TxnDate, total: Number(p.TotalAmt || 0), status: 'Open',
    }));
  },
  async createBill(draft, file) {
    const warnings = [];
    let vendorId = draft.vendor.id;
    if (!vendorId) vendorId = (await this.createVendor(draft.vendor)).id;
    const useCodes = draft.lines.some((l) => l.taxCode) || !!get('QBO_DEFAULT_TAX_CODE');
    const lines = draft.lines.map((l) => ({
      DetailType: 'AccountBasedExpenseLineDetail', Amount: round2(l.amount), Description: (l.description || '').slice(0, 4000),
      AccountBasedExpenseLineDetail: { AccountRef: { value: l.accountId }, ...(useCodes ? { TaxCodeRef: { value: l.taxCode || get('QBO_DEFAULT_TAX_CODE') } } : {}) },
    }));
    // No tax codes (typical for US companies): record any tax on the invoice as its own line so the bill total matches.
    if (!useCodes && draft.tax > 0.005) {
      lines.push({ DetailType: 'AccountBasedExpenseLineDetail', Amount: round2(draft.tax), Description: 'Tax as shown on the invoice', AccountBasedExpenseLineDetail: { AccountRef: { value: draft.lines[0].accountId } } });
    }
    const body = {
      VendorRef: { value: vendorId }, TxnDate: draft.date, DueDate: draft.dueDate, DocNumber: String(draft.number).slice(0, 21), Line: lines,
      ...(useCodes ? { GlobalTaxCalculation: 'TaxExcluded' } : {}),
      PrivateNote: [draft.poNumber ? `PO ${draft.poNumber}` : '', 'Posted by AI Ali after approval'].filter(Boolean).join(' · ').slice(0, 4000),
    };
    const j = await call('POST', '/bill', body);
    const b = j.Bill;
    if (Math.abs(Number(b.TotalAmt) - draft.total) > 0.02) warnings.push(`QuickBooks calculated a total of ${b.TotalAmt}, the invoice says ${draft.total}. Check the tax codes on this bill.`);
    if (file) {
      try {
        const fd = new FormData();
        fd.append('file_metadata_01', new Blob([JSON.stringify({ AttachableRef: [{ EntityRef: { type: 'Bill', value: b.Id } }], FileName: file.name, ContentType: file.type })], { type: 'application/json' }), 'metadata.json');
        fd.append('file_content_01', new Blob([file.data], { type: file.type }), file.name);
        await call('POST', '/upload', fd);
      } catch (e) { warnings.push(`Bill posted, but attaching the invoice file failed: ${e.message}`); }
    }
    return { id: b.Id, url: `${APP()}/app/bill?txnId=${b.Id}`, total: Number(b.TotalAmt), tax: Number(b.TxnTaxDetail?.TotalTax || 0), warnings };
  },
};
