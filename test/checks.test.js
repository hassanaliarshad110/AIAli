import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDataDir } from './helpers.js';

freshDataDir('checks');
const { runTool } = await import('../src/tools.js');
const ap = await import('../src/ap.js');
const { EXTRACT } = await import('./mocks.js');

const codes = (r) => r.findings.map((f) => f.code);

test('a clean invoice passes and matches the vendor', async () => {
  const r = await runTool('check_invoice', EXTRACT['northwind-INV-10458.pdf'].d);
  assert.equal(r.result, 'pass');
  assert.equal(r.resolved.vendor.id, 'V1');
});

test('an invoice already in the ledger is blocked as a duplicate', async () => {
  const r = await runTool('check_invoice', EXTRACT['bowriver-BRC-2291.pdf'].d);
  assert.equal(r.result, 'blocked');
  assert.ok(codes(r).includes('duplicate'));
  const p = await runTool('propose_bill', EXTRACT['bowriver-BRC-2291.pdf'].d);
  assert.equal(p.queued, false);
});

test('duplicate numbers match despite formatting (INV 0010391 = inv-10391)', async () => {
  const d = { ...EXTRACT['northwind-INV-10458.pdf'].d, invoice_number: 'INV 0010391' };
  assert.ok(codes(await runTool('check_invoice', d)).includes('duplicate'));
});

test('PO within tolerance matches; PO over-run is a warning', async () => {
  assert.ok(codes(await runTool('check_invoice', EXTRACT['peakit-PIT-5601.pdf'].d)).includes('po_match'));
  const r = await runTool('check_invoice', EXTRACT['parkside-PL-3349.png'].d);
  assert.equal(r.result, 'review');
  assert.ok(codes(r).includes('po_amount'));
});

test('new vendor and an odd tax rate need review', async () => {
  const r = await runTool('check_invoice', EXTRACT['chinook-catering-CC-0912.pdf'].d);
  assert.equal(r.result, 'review');
  assert.deepEqual(codes(r).sort(), ['tax_rate', 'vendor_new']);
});

test('arithmetic, dates and accounts are enforced', async () => {
  const base = EXTRACT['northwind-INV-10458.pdf'].d;
  assert.ok(codes(await runTool('check_invoice', { ...base, invoice_number: 'X1', total: 1700 })).includes('subtotal_tax_total'));
  assert.ok(codes(await runTool('check_invoice', { ...base, invoice_number: 'X2', due_date: '2026-01-01' })).includes('due_before_date'));
  assert.ok(codes(await runTool('check_invoice', { ...base, invoice_number: 'X3', lines: [{ description: 'x', amount: 1597.5, account_id: '9999' }] })).includes('account_unknown'));
  assert.ok(codes(await runTool('check_invoice', { ...base, invoice_number: 'X4', invoice_date: '14/11/2026' })).includes('date_invalid'));
});

test('propose → approve posts to the ledger, and the same invoice cannot be posted twice', async () => {
  const p = await runTool('propose_bill', EXTRACT['northwind-INV-10458.pdf'].d);
  assert.equal(p.queued, true);
  const before = (await runTool('ap_summary')).outstanding;
  const posted = await ap.approve(p.id, { by: 'tester' });
  assert.equal(posted.status, 'posted');
  assert.equal((await runTool('ap_summary')).outstanding, Math.round((before + 1677.38) * 100) / 100);
  await assert.rejects(ap.approve(p.id), /posted, not pending/);
  assert.equal((await runTool('propose_bill', EXTRACT['northwind-INV-10458.pdf'].d)).queued, false);
});

test('warnings must be acknowledged before posting', async () => {
  const p = await runTool('propose_bill', EXTRACT['chinook-catering-CC-0912.pdf'].d);
  await assert.rejects(ap.approve(p.id), /Review needed/);
  const posted = await ap.approve(p.id, { acknowledgeWarnings: true });
  assert.equal(posted.status, 'posted');
  const v = await runTool('search_vendors', { query: 'Chinook Catering' });
  assert.equal(v.matches[0].name, 'Chinook Catering Co.'); // created on approval
});

test('AI posting tool only exists when switched on', async () => {
  const { toolList } = await import('../src/tools.js');
  assert.ok(!toolList().some((t) => t.name === 'approve_and_post'));
  process.env.ALLOW_AI_POSTING = 'true';
  assert.ok(toolList().some((t) => t.name === 'approve_and_post'));
  delete process.env.ALLOW_AI_POSTING;
  await assert.rejects(runTool('approve_and_post', { id: 'x' }), /turned off/);
});
