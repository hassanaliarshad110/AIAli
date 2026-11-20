// Gmail: reads invoice attachments with the Gmail API (read-only access, gmail.readonly).
// Setup: Google Cloud console → enable the Gmail API → OAuth client (Web application) with the redirect URI from Settings.
import { get, publicUrl } from '../config.js';
import { tokens, setTokens } from '../store.js';
import { readJson } from '../util.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH = () => get('GMAIL_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = () => get('GMAIL_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
const API = () => get('GMAIL_API_BASE') || 'https://gmail.googleapis.com';
export const gmailRedirect = () => `${publicUrl()}/oauth/gmail/callback`;

export function gmailAuthorizeUrl(state) {
  const u = new URL(AUTH());
  u.search = new URLSearchParams({
    client_id: get('GMAIL_CLIENT_ID'), redirect_uri: gmailRedirect(), response_type: 'code', scope: `openid email ${GMAIL_SCOPE}`,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  }).toString();
  return u.toString();
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: get('GMAIL_CLIENT_ID'), client_secret: get('GMAIL_CLIENT_SECRET'), ...body }) });
  const j = await readJson(res);
  if (!res.ok) throw new Error(`Gmail sign-in failed: ${j.error_description || j.error || res.status}${j.error === 'invalid_grant' ? ' (reconnect Gmail in Settings; if the Google app is in Testing mode, access expires every 7 days)' : ''}`);
  return { access_token: j.access_token, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
}

async function api(path) {
  const t = await accessToken();
  const res = await fetch(`${API()}/gmail/v1/users/me${path}`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } });
  const j = await readJson(res);
  if (!res.ok) throw new Error(`Gmail: ${j.error?.message || res.status}`);
  return j;
}

export async function gmailExchange(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: gmailRedirect() });
  setTokens('gmail', { ...t, connected_at: new Date().toISOString() });
  const p = await api('/profile');
  setTokens('gmail', { account: p.emailAddress });
}

async function accessToken() {
  const t = tokens('gmail');
  if (!t?.refresh_token) throw new Error('Gmail is not connected.');
  if (t.access_token && Date.now() < t.expires_at) return t;
  setTokens('gmail', await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
  return tokens('gmail');
}

const header = (m, name) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function attachments(part, out = []) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    const disp = (part.headers || []).find((h) => h.name.toLowerCase() === 'content-disposition')?.value || '';
    out.push({ id: part.body.attachmentId, name: part.filename, type: part.mimeType, size: part.body.size || 0, inline: /^inline/i.test(disp) });
  }
  for (const p of part.parts || []) attachments(p, out);
  return out;
}

// Yields { key, name, type, data (Buffer), from, subject, receivedAt } for each candidate attachment.
export const gmail = {
  key: 'gmail',
  label: 'Gmail',
  connected: () => !!tokens('gmail')?.refresh_token,
  account: () => tokens('gmail')?.account || '',
  async *fetch({ since }) {
    const after = Math.floor(since.getTime() / 1000);
    const q = `${get('GMAIL_QUERY')} after:${after}`;
    let pageToken = '', pages = 0;
    do {
      const list = await api(`/messages?maxResults=50&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const ref of list.messages || []) {
        const m = await api(`/messages/${ref.id}?format=full`);
        for (const a of attachments(m.payload)) {
          yield {
            key: `gmail:${m.id}:${a.name}`, name: a.name, type: a.type, size: a.size, inline: a.inline,
            from: header(m, 'From'), subject: header(m, 'Subject'), receivedAt: new Date(Number(m.internalDate) || Date.now()).toISOString(),
            load: async () => Buffer.from((await api(`/messages/${m.id}/attachments/${a.id}`)).data, 'base64url'),
          };
        }
      }
      pageToken = list.nextPageToken || '';
    } while (pageToken && ++pages < 5);
  },
};
