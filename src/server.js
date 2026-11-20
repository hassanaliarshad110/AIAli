#!/usr/bin/env node
// AI Ali: web app + API + AI connector (MCP). No dependencies, Node 20+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, get, bool, save, publicView, mcpToken, publicUrl } from './config.js';
import * as store from './store.js';
import * as ap from './ap.js';
import { ledger, cached, clearCache } from './ledger/index.js';
import { resetDemo } from './ledger/demo.js';
import { qboAuthorizeUrl, qboExchange, qboRedirect } from './ledger/qbo.js';
import { xeroAuthorizeUrl, xeroExchange, xeroRedirect, XERO_SCOPES } from './ledger/xero.js';
import { runTurn, provider } from './agent.js';
import { mcpHandle } from './mcp.js';
import { toolList } from './tools.js';
import * as intake from './intake/index.js';
import { gmailAuthorizeUrl, gmailExchange, gmailRedirect } from './intake/gmail.js';
import { outlookAuthorizeUrl, outlookExchange, outlookRedirect } from './intake/outlook.js';

const PUBLIC = path.join(ROOT, 'public');
const SAMPLES = path.join(ROOT, 'samples');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_BODY = 20 * 1024 * 1024;

const send = (res, code, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isBuf || typeof body === 'string' ? body : JSON.stringify(body));
};
const html = (res, code, msg) => send(res, code, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>AI Ali</title><body style="font:16px system-ui;padding:40px;max-width:640px;margin:auto"><p>${msg}</p><p><a href="/#settings">Back to AI Ali</a></p>`, { 'content-type': 'text/html; charset=utf-8' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('File too large (20 MB max).')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = async (req) => { const b = await readBody(req); try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw new Error('Invalid JSON'); } };

// Optional password for the web app (required if you expose it beyond localhost). The connector uses its own secret URL.
function authorized(req) {
  const pw = get('APP_PASSWORD');
  if (!pw) return true;
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const given = Buffer.from(b64 || '', 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(given), b = Buffer.from(pw);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const oauthStates = new Map();
const newState = (ledgerKey) => { const s = crypto.randomBytes(16).toString('hex'); oauthStates.set(s, { ledgerKey, at: Date.now() }); return s; };
const takeState = (s, ledgerKey) => { const v = oauthStates.get(s); oauthStates.delete(s); return v && v.ledgerKey === ledgerKey && Date.now() - v.at < 600000; };

// Streams progress as newline-delimited JSON so the UI can show each step the agent takes.
async function stream(res, fn) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const emit = (o) => res.write(JSON.stringify(o) + '\n');
  try { emit({ type: 'done', ...(await fn(emit)) }); } catch (e) { emit({ type: 'error', error: e.message }); }
  res.end();
}

async function status() {
  const P = provider();
  const info = await ledger().info().catch((e) => ({ connected: false, error: e.message }));
  const q = store.queueAll();
  return {
    ledger: { key: ledger().key, label: ledger().label, ...info },
    ai: { provider: P.name, model: P.model(), ready: P.ready() },
    queue: { pending: q.filter((x) => x.status === 'pending').length, posted: q.filter((x) => x.status === 'posted').length },
    connector: { url: `${publicUrl()}/mcp/${mcpToken()}`, local: !/^https:/.test(publicUrl()), tools: toolList().map((t) => t.name), aiPosting: bool('ALLOW_AI_POSTING') },
    oauth: { qboRedirect: qboRedirect(), xeroRedirect: xeroRedirect(), xeroScopes: XERO_SCOPES, qboReady: !!(get('QBO_CLIENT_ID') && get('QBO_CLIENT_SECRET')), xeroReady: !!(get('XERO_CLIENT_ID') && get('XERO_CLIENT_SECRET')), qboConnected: !!store.tokens('qbo')?.refresh_token, xeroConnected: !!store.tokens('xero')?.refresh_token },
    intake: { sources: intake.status(), running: intake.isRunning(), enabled: bool('INTAKE_ENABLED'), every: get('INTAKE_INTERVAL_MIN'), gmailRedirect: gmailRedirect(), outlookRedirect: outlookRedirect(), gmailReady: !!(get('GMAIL_CLIENT_ID') && get('GMAIL_CLIENT_SECRET')), outlookReady: !!(get('OUTLOOK_CLIENT_ID') && get('OUTLOOK_CLIENT_SECRET')) },
    passwordSet: !!get('APP_PASSWORD'),
  };
}

const routes = [
  ['GET', /^\/api\/status$/, async () => status()],
  ['GET', /^\/api\/settings$/, async () => publicView()],
  ['POST', /^\/api\/settings$/, async (req) => {
    const body = await json(req);
    // Masked secrets come back unchanged from the form: don't overwrite the real value with the mask.
    for (const k of Object.keys(body)) if (typeof body[k] === 'string' && body[k].startsWith('••••')) delete body[k];
    save(body); clearCache(); store.audit('settings_changed', { by: 'user', keys: Object.keys(body) });
    return publicView();
  }],
  ['GET', /^\/api\/summary$/, async () => ap.summary()],
  ['GET', /^\/api\/bills$/, async (req, m, url) => ap.listBills({ status: url.searchParams.get('status') || 'open', vendor: url.searchParams.get('vendor') || undefined, limit: 200 })],
  ['GET', /^\/api\/lookups$/, async () => ({ vendors: await cached('vendors', () => ledger().listVendors()), accounts: await cached('accounts', () => ledger().listAccounts()), taxCodes: await cached('taxcodes', () => ledger().listTaxCodes()) })],
  ['GET', /^\/api\/queue$/, async (req, m, url) => ({ items: ap.queue({ status: url.searchParams.get('status') || 'all' }) })],
  ['POST', /^\/api\/queue\/([\w-]+)\/approve$/, async (req, m) => { const b = await json(req); return ap.approve(m[1], { by: 'user', acknowledgeWarnings: !!b.acknowledgeWarnings }); }],
  ['POST', /^\/api\/queue\/([\w-]+)\/reject$/, async (req, m) => { const b = await json(req); return ap.reject(m[1], { by: 'user', reason: b.reason || '' }); }],
  ['POST', /^\/api\/queue\/([\w-]+)\/edit$/, async (req, m) => { const b = await json(req); return ap.editQueued(m[1], b.draft || b, { by: 'user' }); }],
  ['GET', /^\/api\/audit$/, async () => ({ events: store.auditLog(300) })],
  ['POST', /^\/api\/demo\/reset$/, async () => { resetDemo(); clearCache(); store.audit('demo_reset', { by: 'user' }); return { ok: true }; }],
  ['POST', /^\/api\/disconnect$/, async (req) => { const b = await json(req); if (['qbo', 'xero', 'gmail', 'outlook'].includes(b.ledger)) store.setTokens(b.ledger, null); clearCache(); store.audit('disconnected', { by: 'user', ledger: b.ledger }); return { ok: true }; }],
  ['GET', /^\/api\/intake$/, async () => ({ sources: intake.status(), running: intake.isRunning(), log: store.intakeLogs(100) })],
];

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // ---- AI connector (MCP over Streamable HTTP). The token in the path is the secret.
  const mm = p.match(/^\/mcp\/([\w-]+)\/?$/);
  if (mm) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id, authorization', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);
    const a = Buffer.from(mm[1]), b = Buffer.from(mcpToken());
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 404, { error: 'Not found' }, cors);
    if (req.method === 'GET') return send(res, 405, { error: 'Use POST' }, { ...cors, allow: 'POST' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, cors);
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors); }
    const out = await mcpHandle(body, { client: String(req.headers['user-agent'] || 'http').slice(0, 40) });
    return out ? send(res, 200, out, cors) : send(res, 202, '', cors);
  }

  if (!authorized(req)) return send(res, 401, 'Password required', { 'www-authenticate': 'Basic realm="AI Ali"', 'content-type': 'text/plain' });

  // ---- OAuth for QuickBooks / Xero
  if (p === '/oauth/qbo/start') {
    if (!get('QBO_CLIENT_ID') || !get('QBO_CLIENT_SECRET')) return html(res, 400, 'Add your QuickBooks client id and secret in Settings first.');
    return send(res, 302, '', { location: qboAuthorizeUrl(newState('qbo')) });
  }
  if (p === '/oauth/xero/start') {
    if (!get('XERO_CLIENT_ID') || !get('XERO_CLIENT_SECRET')) return html(res, 400, 'Add your Xero client id and secret in Settings first.');
    return send(res, 302, '', { location: xeroAuthorizeUrl(newState('xero')) });
  }
  const START = { gmail: ['GMAIL', 'Gmail', gmailAuthorizeUrl], outlook: ['OUTLOOK', 'Outlook', outlookAuthorizeUrl] };
  const ms = p.match(/^\/oauth\/(gmail|outlook)\/start$/);
  if (ms) {
    const [pfx, label, fn] = START[ms[1]];
    if (!get(`${pfx}_CLIENT_ID`) || !get(`${pfx}_CLIENT_SECRET`)) return html(res, 400, `Add your ${label} client id and secret in Settings first.`);
    return send(res, 302, '', { location: fn(newState(ms[1])) });
  }
  const mc = p.match(/^\/oauth\/(gmail|outlook)\/callback$/);
  if (mc) {
    const sp = url.searchParams;
    if (sp.get('error')) return html(res, 400, `Connection cancelled: ${sp.get('error_description') || sp.get('error')}`);
    if (!takeState(sp.get('state'), mc[1])) return html(res, 400, 'This sign-in link expired. Start again from Settings.');
    try {
      await (mc[1] === 'gmail' ? gmailExchange : outlookExchange)(sp.get('code'));
      store.audit('connected', { by: 'user', source: mc[1] });
      return send(res, 302, '', { location: '/#settings' });
    } catch (e) { return html(res, 400, `Couldn't connect: ${e.message}`); }
  }
  if (req.method === 'POST' && p === '/api/intake/run') {
    if (!provider().ready()) return send(res, 400, { error: 'Add an AI API key in Settings first.' });
    return stream(res, async (emit) => ({ results: await intake.runAll({ onEvent: emit }) }));
  }
  if (p === '/oauth/qbo/callback' || p === '/oauth/xero/callback') {
    const which = p.includes('qbo') ? 'qbo' : 'xero';
    const sp = url.searchParams;
    if (sp.get('error')) return html(res, 400, `Connection cancelled: ${sp.get('error')}`);
    if (!takeState(sp.get('state'), which)) return html(res, 400, 'This sign-in link expired. Start again from Settings.');
    try {
      if (which === 'qbo') await qboExchange(sp.get('code'), sp.get('realmId'));
      else await xeroExchange(sp.get('code'));
      save({ LEDGER: which }); clearCache(); store.audit('connected', { by: 'user', ledger: which });
      return send(res, 302, '', { location: '/#settings' });
    } catch (e) { return html(res, 400, `Couldn't connect: ${e.message}`); }
  }

  // ---- uploads, chat and invoice processing
  if (req.method === 'POST' && p === '/api/upload') {
    const type = String(req.headers['content-type'] || '').split(';')[0];
    const name = decodeURIComponent(String(req.headers['x-filename'] || 'invoice'));
    const f = store.saveFile(await readBody(req), name, type);
    return send(res, 200, { id: f.sha, name: f.name, type: f.type, size: f.size });
  }
  if (req.method === 'POST' && p === '/api/process') {
    const b = await json(req);
    const f = store.getFile(b.fileId);
    if (!f) return send(res, 404, { error: 'File not found' });
    return stream(res, (emit) => runTurn({ text: b.instructions || 'Process this invoice: extract it, check it and propose the bill.', file: { name: f.name, type: f.type, data: store.readFile(f.sha) }, fileId: f.sha, source: 'inbox', onEvent: emit }));
  }
  if (req.method === 'POST' && p === '/api/chat') {
    const b = await json(req);
    if (!String(b.text || '').trim()) return send(res, 400, { error: 'Empty message' });
    return stream(res, (emit) => runTurn({ sessionId: b.sessionId, text: String(b.text).slice(0, 8000), onEvent: emit }));
  }
  const qf = p.match(/^\/api\/queue\/([\w-]+)\/file$/);
  if (qf) {
    const q = store.queueGet(qf[1]);
    const f = q?.file && store.getFile(q.file.id);
    if (!f) return send(res, 404, { error: 'No file' });
    return send(res, 200, store.readFile(f.sha), { 'content-type': f.type, 'content-disposition': `inline; filename="${f.name.replace(/"/g, '')}"` });
  }

  for (const [method, re, fn] of routes) {
    const m = p.match(re);
    if (m && req.method === method) return send(res, 200, await fn(req, m, url));
  }

  // ---- static files: the web app and the sample invoices
  if (req.method === 'GET') {
    const base = p.startsWith('/samples/') ? SAMPLES : PUBLIC;
    const rel = p.startsWith('/samples/') ? p.slice('/samples/'.length) : p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(base, path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(base) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

export function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((e) => { if (!res.headersSent) send(res, 400, { error: e.message }); else res.end(); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(get('PORT')), host = get('HOST');
  createServer().listen(port, host, () => {
    console.log(`\n  AI Ali is running: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
    console.log(`  Ledger: ${ledger().label}   AI: ${provider().name} (${provider().ready() ? 'key set' : 'no key yet, add one in Settings'})`);
    if (host !== '127.0.0.1' && host !== 'localhost' && !get('APP_PASSWORD')) console.log('  WARNING: reachable from other machines without APP_PASSWORD. Set APP_PASSWORD in .env.');
    const on = Object.values(intake.status()).filter((s) => s.connected).map((s) => s.label);
    console.log(`  Automatic intake: ${on.length ? `${on.join(', ')}, every ${get('INTAKE_INTERVAL_MIN')} min${bool('INTAKE_ENABLED') ? '' : ' (paused)'}` : 'no sources connected'}`);
    intake.startScheduler();
    console.log('');
  });
}
