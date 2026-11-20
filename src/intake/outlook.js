// Outlook / Microsoft 365: reads invoice attachments with Microsoft Graph (delegated Mail.Read).
// Setup: Microsoft Entra admin center → App registrations → New (Web redirect URI from Settings) → client secret → API permission Mail.Read.
import { get, publicUrl } from '../config.js';
import { tokens, setTokens } from '../store.js';
import { readJson } from '../util.js';

export const OUTLOOK_SCOPES = 'offline_access openid email User.Read Mail.Read';
const LOGIN = () => get('OUTLOOK_LOGIN_BASE') || 'https://login.microsoftonline.com';
const GRAPH = () => get('OUTLOOK_GRAPH_BASE') || 'https://graph.microsoft.com';
const tenant = () => get('OUTLOOK_TENANT') || 'common';
export const outlookRedirect = () => `${publicUrl()}/oauth/outlook/callback`;

export function outlookAuthorizeUrl(state) {
  const u = new URL(`${LOGIN()}/${tenant()}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({ client_id: get('OUTLOOK_CLIENT_ID'), response_type: 'code', redirect_uri: outlookRedirect(), response_mode: 'query', scope: OUTLOOK_SCOPES, state }).toString();
  return u.toString();
}

async function tokenRequest(body) {
  const res = await fetch(`${LOGIN()}/${tenant()}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: get('OUTLOOK_CLIENT_ID'), client_secret: get('OUTLOOK_CLIENT_SECRET'), scope: OUTLOOK_SCOPES, ...body }) });
  const j = await readJson(res);
  if (!res.ok) throw new Error(`Outlook sign-in failed: ${j.error_description?.split('\r\n')[0] || j.error || res.status}`);
  return { access_token: j.access_token, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
}

async function graph(pathOrUrl) {
  const t = await accessToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH()}/v1.0${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } });
  const j = await readJson(res);
  if (!res.ok) throw new Error(`Outlook: ${j.error?.message || res.status}`);
  return j;
}

export async function outlookExchange(code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: outlookRedirect() });
  setTokens('outlook', { ...t, connected_at: new Date().toISOString() });
  const me = await graph('/me?$select=mail,userPrincipalName');
  setTokens('outlook', { account: me.mail || me.userPrincipalName });
}

async function accessToken() {
  const t = tokens('outlook');
  if (!t?.refresh_token) throw new Error('Outlook is not connected.');
  if (t.access_token && Date.now() < t.expires_at) return t;
  setTokens('outlook', await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
  return tokens('outlook');
}

export const outlook = {
  key: 'outlook',
  label: 'Outlook',
  connected: () => !!tokens('outlook')?.refresh_token,
  account: () => tokens('outlook')?.account || '',
  async *fetch({ since }) {
    const filter = `receivedDateTime ge ${since.toISOString().replace(/\.\d+Z$/, 'Z')} and hasAttachments eq true`;
    const folder = encodeURIComponent(get('OUTLOOK_FOLDER') || 'inbox');
    let url = `/me/mailFolders/${folder}/messages?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('receivedDateTime desc')}&$select=id,subject,from,receivedDateTime&$top=50`;
    let pages = 0;
    while (url && pages++ < 5) {
      const list = await graph(url);
      for (const m of list.value || []) {
        const att = await graph(`/me/messages/${m.id}/attachments`);
        for (const a of att.value || []) {
          if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
          yield {
            key: `outlook:${m.id}:${a.id}`, name: a.name, type: a.contentType, size: a.size || 0, inline: !!a.isInline,
            from: m.from?.emailAddress ? `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address}>` : '', subject: m.subject || '', receivedAt: m.receivedDateTime,
            load: async () => Buffer.from(a.contentBytes || '', 'base64'),
          };
        }
      }
      url = list['@odata.nextLink'] || '';
    }
  },
};
