// The controls an AP clerk would run before posting a bill. Each finding is:
//   block: can't be approved until fixed   warn: a person must review it   info: for context
import { ledger, cached } from './ledger/index.js';
import { queueAll } from './store.js';
import { round2, isDate, daysBetween, normNumber, normName, money, today } from './util.js';
import { num } from './config.js';

// Accepts the shape the AI sends (snake_case) or the internal shape, returns the internal shape.
export function normalizeDraft(d = {}) {
  const lines = (d.lines || []).map((l) => ({
    description: String(l.description ?? '').trim(),
    amount: round2(l.amount),
    accountId: String(l.account_id ?? l.accountId ?? '').trim(),
    taxCode: String(l.tax_code ?? l.taxCode ?? '').trim() || undefined,
  }));
  const lineSum = round2(lines.reduce((s, l) => s + (l.amount || 0), 0));
  const tax = round2(d.tax ?? 0);
  const subtotal = d.subtotal != null && d.subtotal !== '' ? round2(d.subtotal) : lineSum;
  const total = d.total != null && d.total !== '' ? round2(d.total) : round2(subtotal + tax);
  return {
    vendor: { id: d.vendor_id ?? d.vendor?.id ?? undefined, name: String(d.vendor_name ?? d.vendor?.name ?? '').trim(), email: d.vendor_email ?? d.vendor?.email ?? undefined },
    number: String(d.invoice_number ?? d.number ?? '').trim(),
    date: String(d.invoice_date ?? d.date ?? '').trim(),
    dueDate: String(d.due_date ?? d.dueDate ?? '').trim(),
    currency: String(d.currency ?? '').trim().toUpperCase() || undefined,
    poNumber: String(d.po_number ?? d.poNumber ?? '').trim() || undefined,
    lines, subtotal, tax, total, lineSum,
    fileId: d.file_id ?? d.fileId ?? undefined,
    notes: d.notes ? String(d.notes).slice(0, 1000) : undefined,
  };
}

export async function checkDraft(input, { excludeQueueId } = {}) {
  const L = ledger();
  const draft = normalizeDraft(input);
  const f = [];
  const add = (level, code, message) => f.push({ level, code, message });

  // ---- required fields
  if (!draft.vendor.name && !draft.vendor.id) add('block', 'vendor_missing', 'No vendor name.');
  if (!draft.number) add('block', 'number_missing', 'No invoice number.');
  if (!isDate(draft.date)) add('block', 'date_invalid', `Invoice date "${draft.date}" is not a valid YYYY-MM-DD date.`);
  if (!draft.lines.length) add('block', 'no_lines', 'The bill has no lines.');
  if (!(draft.total > 0)) add('block', 'total_invalid', 'The total must be more than zero. Credit notes are not supported yet.');

  // ---- vendor
  const vendors = await cached('vendors', () => L.listVendors());
  let vendor = draft.vendor.id ? vendors.find((v) => String(v.id) === String(draft.vendor.id)) : null;
  if (draft.vendor.id && !vendor) add('block', 'vendor_unknown', `Vendor id ${draft.vendor.id} does not exist in the ledger.`);
  if (!vendor && draft.vendor.name) {
    const n = normName(draft.vendor.name);
    const hits = vendors.filter((v) => normName(v.name) === n);
    if (hits.length === 1) { vendor = hits[0]; add('info', 'vendor_matched', `Matched to existing vendor "${vendor.name}".`); }
    else if (hits.length > 1) add('block', 'vendor_ambiguous', `${hits.length} vendors are called "${draft.vendor.name}". Pick one by id.`);
    else {
      const close = vendors.filter((v) => { const m = normName(v.name); return m && n && (m.includes(n) || n.includes(m)); });
      add('warn', 'vendor_new', `"${draft.vendor.name}" is not in the vendor list and will be created when the bill is approved.${close.length ? ` Similar vendors: ${close.slice(0, 3).map((v) => v.name).join(', ')}.` : ''}`);
    }
  }
  if (vendor) draft.vendor = { id: vendor.id, name: vendor.name, email: vendor.email || draft.vendor.email };

  // ---- dates
  if (isDate(draft.date)) {
    if (!draft.dueDate) { const d = new Date(draft.date); d.setUTCDate(d.getUTCDate() + 30); draft.dueDate = d.toISOString().slice(0, 10); add('info', 'due_default', `No due date on the invoice, so net 30 was used (${draft.dueDate}).`); }
    else if (!isDate(draft.dueDate)) add('block', 'due_invalid', `Due date "${draft.dueDate}" is not a valid YYYY-MM-DD date.`);
    else if (draft.dueDate < draft.date) add('block', 'due_before_date', 'The due date is before the invoice date.');
    const age = daysBetween(draft.date, today());
    if (age < -7) add('warn', 'future_date', `The invoice is dated ${-age} days in the future.`);
    if (age > 180) add('warn', 'old_invoice', `The invoice is ${age} days old. Check that it hasn't been paid already.`);
  }

  // ---- accounts and tax codes
  const accounts = await cached('accounts', () => L.listAccounts());
  const taxCodes = await cached('taxcodes', () => L.listTaxCodes());
  draft.lines.forEach((l, i) => {
    if (!(l.amount > 0)) add('block', 'line_amount', `Line ${i + 1} has no positive amount.`);
    const a = accounts.find((x) => String(x.id) === l.accountId || (x.code && x.code === l.accountId));
    if (!a) add('block', 'account_unknown', `Line ${i + 1}: account "${l.accountId || '(none)'}" is not an expense account in the ledger.`);
    else { l.accountId = String(a.id); l.accountName = a.name; }
    if (l.taxCode && taxCodes.length && !taxCodes.some((t) => String(t.id) === l.taxCode)) add('block', 'taxcode_unknown', `Line ${i + 1}: tax code "${l.taxCode}" does not exist in the ledger.`);
  });

  // ---- arithmetic
  if (Math.abs(draft.lineSum - draft.subtotal) > 0.02) add('block', 'lines_vs_subtotal', `Lines add up to ${money(draft.lineSum)} but the subtotal is ${money(draft.subtotal)}.`);
  if (Math.abs(draft.subtotal + draft.tax - draft.total) > 0.02) add('block', 'subtotal_tax_total', `Subtotal ${money(draft.subtotal)} + tax ${money(draft.tax)} = ${money(draft.subtotal + draft.tax)}, but the invoice total is ${money(draft.total)}.`);
  if (draft.tax > 0 && draft.subtotal > 0) {
    const rate = (draft.tax / draft.subtotal) * 100;
    const known = [...new Set(taxCodes.map((t) => t.rate).filter((r) => r > 0))];
    if (known.length && !known.some((r) => Math.abs(r - rate) < 0.15)) add('warn', 'tax_rate', `Tax is ${rate.toFixed(2)}% of the subtotal, which doesn't match any tax rate in the ledger (${known.map((r) => r + '%').join(', ')}).`);
  }

  // ---- duplicates: in the ledger and in this app's own queue
  if (draft.number) {
    const same = (await L.findBillsByNumber(draft.number)).concat((await cached('bills', () => L.listBills())).filter((b) => normNumber(b.number) === normNumber(draft.number)));
    const seen = new Set();
    for (const b of same) {
      if (seen.has(b.id)) continue; seen.add(b.id);
      const sameVendor = draft.vendor.id ? String(b.vendorId) === String(draft.vendor.id) : normName(b.vendorName) === normName(draft.vendor.name);
      if (sameVendor) add('block', 'duplicate', `Already in the ledger: ${b.vendorName} ${b.number}, ${money(b.total, b.currency)}, dated ${b.date} (${b.status}).`);
      else add('warn', 'number_reused', `Another vendor (${b.vendorName}) has a bill with the same number ${b.number}.`);
    }
  }
  for (const q of queueAll()) {
    if (q.id === excludeQueueId || q.status === 'rejected' || q.status === 'failed') continue;
    const qd = q.draft;
    if (normNumber(qd.number) === normNumber(draft.number) && normName(qd.vendor.name) === normName(draft.vendor.name)) add('block', 'duplicate_queue', `This invoice is already in the approval queue (${q.id}, ${q.status}).`);
    else if (draft.fileId && qd.fileId === draft.fileId) add('block', 'duplicate_file', `The same file was already proposed as ${q.id} (${q.status}).`);
  }
  if (draft.vendor.id && isDate(draft.date)) {
    const near = (await cached('bills', () => L.listBills())).filter((b) => String(b.vendorId) === String(draft.vendor.id) && Math.abs(b.total - draft.total) < 0.01 && normNumber(b.number) !== normNumber(draft.number) && Math.abs(daysBetween(b.date, draft.date)) <= 10);
    for (const b of near) add('warn', 'possible_duplicate', `Possible duplicate: ${b.vendorName} ${b.number} has the same amount (${money(b.total)}) and is dated ${b.date}.`);
  }

  // ---- purchase order match
  const pos = await cached('pos', () => L.listPurchaseOrders());
  if (draft.poNumber) {
    const po = pos.find((p) => normNumber(p.number) === normNumber(draft.poNumber));
    if (!po) add('warn', 'po_not_found', `PO ${draft.poNumber} is not an open purchase order in the ledger.`);
    else {
      if (draft.vendor.id && String(po.vendorId) !== String(draft.vendor.id)) add('warn', 'po_vendor', `PO ${po.number} belongs to ${po.vendorName}, not ${draft.vendor.name}.`);
      const tol = num('PO_TOLERANCE_PCT') / 100;
      const within = (x) => Math.abs(x - po.total) <= po.total * tol + 0.01;
      if (within(draft.total) || within(draft.subtotal)) add('info', 'po_match', `Matches PO ${po.number} (${money(po.total)}).`);
      else add('warn', 'po_amount', `Invoice ${money(draft.total)} (subtotal ${money(draft.subtotal)}) differs from PO ${po.number} ${money(po.total)} by more than ${num('PO_TOLERANCE_PCT')}%.`);
    }
  } else if (draft.vendor.id) {
    const open = pos.filter((p) => String(p.vendorId) === String(draft.vendor.id));
    if (open.length) add('info', 'po_available', `${draft.vendor.name} has open POs: ${open.map((p) => `${p.number} (${money(p.total)})`).join(', ')}. The invoice doesn't quote one.`);
  }

  if (draft.currency && vendor?.currency && vendor.currency !== draft.currency) add('warn', 'currency', `Invoice is in ${draft.currency}, the vendor is set up in ${vendor.currency}.`);

  const result = f.some((x) => x.level === 'block') ? 'blocked' : f.some((x) => x.level === 'warn') ? 'review' : 'pass';
  return { result, findings: f, draft };
}
