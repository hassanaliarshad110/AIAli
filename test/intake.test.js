import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDataDir, startApp } from './helpers.js';
import { anthropicMock, gmailMock, graphMock } from './mocks.js';

freshDataDir('intake');
const sample = (f) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url));
const logo = Buffer.alloc(2000, 1); // tiny "image": a signature logo
const gFiles = [
  { id: 'm1', name: 'northwind-INV-10458.pdf', type: 'application/pdf', data: sample('northwind-INV-10458.pdf'), from: 'Northwind <ar@nw.example>', subject: 'Invoice INV-10458' },
  { id: 'm2', name: 'logo.png', type: 'image/png', data: logo, from: 'Someone <x@y.example>', subject: 'Hi', inline: true },
  { id: 'm3', name: 'newsletter.pdf', type: 'application/octet-stream', data: fs.readFileSync(new URL('newsletter.pdf', import.meta.url)), from: 'Promo <p@promo.example>', subject: 'Spring offers' },
];
const oFiles = [
  { id: 'o1', name: 'peakit-PIT-5601.pdf', type: 'application/pdf', data: sample('peakit-PIT-5601.pdf'), from: 'accounts@peakit.example', subject: 'Invoice PIT-5601' },
  { id: 'o2', name: 'northwind-copy.pdf', type: 'application/pdf', data: sample('northwind-INV-10458.pdf'), from: 'ar@nw.example', subject: 'Fwd: Invoice INV-10458' }, // same file sent twice
];
const gLog = [], oLog = [], aLog = [];
const A = await anthropicMock(aLog), G = await gmailMock(gFiles, gLog), O = await graphMock(oFiles, oLog);
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-folder-'));
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: A.url, ANTHROPIC_API_KEY: 'sk-ant-x',
  GMAIL_CLIENT_ID: 'gid', GMAIL_CLIENT_SECRET: 'gsec', GMAIL_AUTH_URL: `${G.url}/auth`, GMAIL_TOKEN_URL: `${G.url}/token`, GMAIL_API_BASE: G.url,
  OUTLOOK_CLIENT_ID: 'oid', OUTLOOK_CLIENT_SECRET: 'osec', OUTLOOK_LOGIN_BASE: O.url, OUTLOOK_GRAPH_BASE: O.url,
});
const app = await startApp();
after(() => { app.close(); A.close(); G.close(); O.close(); });

async function connect(source) {
  const r = await fetch(`${app.base}/oauth/${source}/start`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  const cb = await fetch(`${app.base}/oauth/${source}/callback?code=c&state=${loc.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  return loc;
}

test('Gmail: read-only scope, offline access, and invoices picked up while logos and newsletters are not queued', async () => {
  const loc = await connect('gmail');
  assert.match(loc.searchParams.get('scope'), /gmail\.readonly/);
  assert.ok(!/gmail\.modify|mail\.google\.com/.test(loc.searchParams.get('scope')));
  assert.equal(loc.searchParams.get('access_type'), 'offline');
  const st = (await app.j('/api/intake')).body.sources.gmail;
  assert.equal(st.connected, true); assert.equal(st.account, 'ap@maple.example');

  const ev = await app.ndjson('/api/intake/run', {});
  const [res] = ev.at(-1).results;
  assert.equal(res.source, 'gmail');
  assert.equal(res.processed, 2, JSON.stringify(res)); // the invoice and the newsletter; the inline logo is skipped
  assert.equal(res.queued, 1);
  assert.ok(gLog.some((l) => l.path.endsWith('/messages') && /after%3A\d+/.test(l.search)));
  const log = (await app.j('/api/intake')).body.log;
  assert.deepEqual(log.map((l) => l.result).sort(), ['not_invoice', 'queued']);
  const q = (await app.j('/api/queue?status=pending')).body.items;
  assert.equal(q[0].draft.number, 'INV-10458');
  assert.ok(q[0].file); // the email attachment is attached to the bill
  assert.equal(aLog[0].body.messages[0].content[0].type, 'document');
  assert.match(aLog[0].body.messages[0].content[1].text, /arrived by Gmail from Northwind/);

  // a second check does nothing new (and costs no AI calls)
  const n = aLog.length;
  const ev2 = await app.ndjson('/api/intake/run', {});
  assert.equal(ev2.at(-1).results[0].processed, 0);
  assert.equal(aLog.length, n);
});

test('Outlook: Graph Mail.Read, date filter, and the same PDF from another mailbox is not processed twice', async () => {
  const loc = await connect('outlook');
  assert.equal(loc.pathname, '/common/oauth2/v2.0/authorize');
  assert.match(loc.searchParams.get('scope'), /Mail\.Read/);
  assert.match(loc.searchParams.get('scope'), /offline_access/);
  const ev = await app.ndjson('/api/intake/run', {});
  const res = ev.at(-1).results.find((r) => r.source === 'outlook');
  assert.equal(res.processed, 1, JSON.stringify(res));
  assert.equal(res.queued, 1);
  assert.ok(oLog.some((l) => /receivedDateTime ge \d{4}-\d\d-\d\dT[\d:]+Z and hasAttachments eq true/.test(l.search)));
  const log = (await app.j('/api/intake')).body.log;
  assert.ok(log.some((l) => l.result === 'already_seen' && l.file === 'northwind-copy.pdf'));
});

test('Folder: PDFs in the folder are picked up, renamed copies are ignored, and files can be moved to "processed"', async () => {
  fs.copyFileSync(new URL('../samples/chinook-catering-CC-0912.pdf', import.meta.url), path.join(folder, 'scan-001.pdf'));
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not an invoice');
  const old = new Date(Date.now() - 60000);
  for (const f of fs.readdirSync(folder)) fs.utimesSync(path.join(folder, f), old, old);
  await app.j('/api/settings', { method: 'POST', body: JSON.stringify({ WATCH_FOLDER: folder, MOVE_PROCESSED: 'true' }) });
  const ev = await app.ndjson('/api/intake/run', {});
  const res = ev.at(-1).results.find((r) => r.source === 'folder');
  assert.equal(res.processed, 1, JSON.stringify(res));
  assert.ok(fs.existsSync(path.join(folder, 'processed', 'scan-001.pdf')));
  assert.ok(fs.existsSync(path.join(folder, 'notes.txt')));
  // the same invoice saved again under another name
  fs.copyFileSync(new URL('../samples/chinook-catering-CC-0912.pdf', import.meta.url), path.join(folder, 'scan-002.pdf'));
  fs.utimesSync(path.join(folder, 'scan-002.pdf'), old, old);
  const ev2 = await app.ndjson('/api/intake/run', {});
  assert.equal(ev2.at(-1).results.find((r) => r.source === 'folder').processed, 0);
});

test('a missing folder is reported, not crashed on', async () => {
  await app.j('/api/settings', { method: 'POST', body: JSON.stringify({ WATCH_FOLDER: '/no/such/folder' }) });
  const ev = await app.ndjson('/api/intake/run', {});
  assert.match(ev.at(-1).results.find((r) => r.source === 'folder').error, /Folder not found/);
  assert.match((await app.j('/api/intake')).body.sources.folder.lastError, /Folder not found/);
});

test('when the AI is down, the invoice is retried on the next check instead of being lost', async () => {
  gFiles.push({ id: 'm9', name: 'peakit-again.pdf', type: 'application/pdf', data: sample('bowriver-BRC-2291.pdf'), from: 'b@b.example', subject: 'Invoice' });
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'; // nothing listens here
  await app.j('/api/settings', { method: 'POST', body: JSON.stringify({ WATCH_FOLDER: '' }) });
  const ev = await app.ndjson('/api/intake/run', {});
  assert.ok(ev.at(-1).results.find((r) => r.source === 'gmail').error);
  process.env.ANTHROPIC_BASE_URL = A.url;
  const ev2 = await app.ndjson('/api/intake/run', {});
  const g = ev2.at(-1).results.find((r) => r.source === 'gmail');
  assert.equal(g.processed, 1, JSON.stringify(g));
  assert.equal(g.queued, 0); // it's the duplicate Bow River invoice: picked up, explained, not queued
});
