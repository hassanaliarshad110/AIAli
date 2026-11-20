import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDataDir, startApp } from './helpers.js';
import { anthropicMock, openaiMock } from './mocks.js';

freshDataDir('agent');
const aLog = [], oLog = [];
const A = await anthropicMock(aLog), O = await openaiMock(oLog);
process.env.ANTHROPIC_BASE_URL = A.url;
process.env.OPENAI_BASE_URL = O.url + '/v1';
const app = await startApp();
after(() => { app.close(); A.close(); O.close(); });

test('no key: a clear error instead of a crash', async () => {
  const ev = await app.ndjson('/api/chat', { text: 'hi' });
  assert.match(ev.at(-1).error, /No Anthropic API key/);
});

test('settings: keys are saved but never sent back in full', async () => {
  await app.j('/api/settings', { method: 'POST', body: JSON.stringify({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-1234', OPENAI_API_KEY: 'sk-openai-9876' }) });
  const s = (await app.j('/api/settings')).body;
  assert.equal(s.ANTHROPIC_API_KEY, '•••• 1234');
  assert.ok(!JSON.stringify(s).includes('sk-ant-test'));
  // the masked value coming back from the form must not overwrite the real key
  await app.j('/api/settings', { method: 'POST', body: JSON.stringify({ ANTHROPIC_API_KEY: '•••• 1234' }) });
  assert.equal((await app.j('/api/status')).body.ai.ready, true);
});

test('Claude reads a PDF invoice, checks it and queues it', async () => {
  const f = await app.upload('peakit-PIT-5601.pdf');
  const ev = await app.ndjson('/api/process', { fileId: f.id });
  const done = ev.at(-1);
  assert.equal(done.type, 'done', JSON.stringify(done));
  assert.deepEqual(ev.filter((e) => e.type === 'tool').map((e) => e.name), ['search_vendors', 'list_accounts', 'check_invoice', 'propose_bill']);
  const first = aLog[0];
  assert.equal(first.key, 'sk-ant-test-1234');
  assert.equal(first.body.messages[0].content[0].type, 'document');
  assert.equal(first.body.messages[0].content[0].source.media_type, 'application/pdf');
  assert.ok(first.body.tools.some((t) => t.name === 'propose_bill' && t.input_schema));
  const q = (await app.j('/api/queue?status=pending')).body.items;
  assert.equal(q.length, 1);
  assert.equal(q[0].draft.poNumber, 'PO-1007');
  assert.equal(q[0].file.id, f.id); // the file is linked even though the model didn't pass file_id
  assert.ok(q[0].checks.findings.some((x) => x.code === 'po_match'));
});

test('a duplicate invoice is explained, not queued', async () => {
  const f = await app.upload('bowriver-BRC-2291.pdf');
  const ev = await app.ndjson('/api/process', { fileId: f.id });
  assert.match(ev.at(-1).answer, /duplicate/i);
  assert.ok(!ev.some((e) => e.name === 'propose_bill'));
});

test('approve from the web app posts the bill with the file attached', async () => {
  const [q] = (await app.j('/api/queue?status=pending')).body.items;
  const r = await app.j(`/api/queue/${q.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'posted');
  const file = await fetch(`${app.base}/api/queue/${q.id}/file`);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  const audit = (await app.j('/api/audit')).body.events.map((e) => e.event);
  assert.ok(audit.includes('posted') && audit.includes('proposed'));
});

test('OpenAI: image invoice via chat completions + function calling', async () => {
  await app.j('/api/settings', { method: 'POST', body: JSON.stringify({ AI_PROVIDER: 'openai' }) });
  const f = await app.upload('parkside-PL-3349.png');
  const ev = await app.ndjson('/api/process', { fileId: f.id });
  assert.equal(ev.at(-1).type, 'done', JSON.stringify(ev.at(-1)));
  const first = oLog[0];
  assert.equal(first.auth, 'Bearer sk-openai-9876');
  assert.equal(first.body.messages[0].role, 'system');
  assert.equal(first.body.messages[1].content[0].type, 'image_url');
  assert.ok(first.body.tools[0].function.parameters);
  const q = (await app.j('/api/queue?status=pending')).body.items;
  assert.equal(q[0].checks.result, 'review'); // over the PO
  // posting needs the warning acknowledged
  const r1 = await app.j(`/api/queue/${q[0].id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(r1.status, 400);
  const r2 = await app.j(`/api/queue/${q[0].id}/approve`, { method: 'POST', body: JSON.stringify({ acknowledgeWarnings: true }) });
  assert.equal(r2.body.status, 'posted');
});

test('OpenAI PDF input uses a file part', async () => {
  const f = await app.upload('northwind-INV-10458.pdf');
  const n = oLog.length;
  await app.ndjson('/api/process', { fileId: f.id });
  const part = oLog[n].body.messages[1].content[0];
  assert.equal(part.type, 'file');
  assert.match(part.file.file_data, /^data:application\/pdf;base64,/);
});

test('chat answers payables questions from tools', async () => {
  const ev = await app.ndjson('/api/chat', { text: 'Give me the AP summary' });
  assert.equal(ev.find((e) => e.type === 'tool').name, 'ap_summary');
  assert.match(ev.at(-1).answer, /open bills/);
});

test('editing a queued bill re-runs the checks', async () => {
  await app.j('/api/settings', { method: 'POST', body: JSON.stringify({ AI_PROVIDER: 'anthropic' }) });
  const f = await app.upload('chinook-catering-CC-0912.pdf');
  await app.ndjson('/api/process', { fileId: f.id });
  const q = (await app.j('/api/queue?status=pending')).body.items.find((x) => x.draft.number === 'CC-0912');
  assert.ok(q.checks.findings.some((x) => x.code === 'tax_rate'));
  const fixed = { ...q.draft, tax: 31.05, total: 652.05 };
  const r = await app.j(`/api/queue/${q.id}/edit`, { method: 'POST', body: JSON.stringify({ draft: fixed }) });
  assert.ok(!r.body.checks.findings.some((x) => x.code === 'tax_rate'));
  const rej = await app.j(`/api/queue/${q.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'Ask vendor for corrected invoice' }) });
  assert.equal(rej.body.status, 'rejected');
});
