// AP operations shared by the web app, the chat agent and the AI connector.
import { ledger, cached, clearCache } from './ledger/index.js';
import { checkDraft } from './checks.js';
import { queueAdd, queueAll, queueGet, queueUpdate, audit, getFile, readFile } from './store.js';
import { round2, today, daysBetween } from './util.js';

const BUCKETS = ['Not yet due', '1-30 days', '31-60 days', '61-90 days', '90+ days'];
const bucket = (overdue) => (overdue <= 0 ? 0 : overdue <= 30 ? 1 : overdue <= 60 ? 2 : overdue <= 90 ? 3 : 4);

export async function summary({ asOf = today() } = {}) {
  const L = ledger();
  const info = await L.info();
  if (!info.connected) return { info, error: info.error || `${L.label} is not connected.` };
  const open = (await cached('openbills', () => L.listBills({ openOnly: true }), 60000)).filter((b) => b.status !== 'Draft');
  const aging = BUCKETS.map((name) => ({ name, amount: 0, count: 0 }));
  const byVendor = new Map();
  let dueWeek = 0, dueWeekCount = 0, overdue = 0, overdueCount = 0;
  const currencies = new Set();
  for (const b of open) {
    const late = daysBetween(b.dueDate, asOf);
    const a = aging[bucket(late)]; a.amount += b.balance; a.count++;
    if (late > 0) { overdue += b.balance; overdueCount++; }
    if (late <= 0 && late >= -7) { dueWeek += b.balance; dueWeekCount++; }
    const v = byVendor.get(b.vendorName) || { vendor: b.vendorName, amount: 0, count: 0 };
    v.amount += b.balance; v.count++; byVendor.set(b.vendorName, v);
    if (b.currency) currencies.add(b.currency);
  }
  aging.forEach((a) => (a.amount = round2(a.amount)));
  const queue = queueAll();
  return {
    info, asOf,
    currency: info.currency || [...currencies][0] || '',
    mixedCurrencies: currencies.size > 1 ? [...currencies] : undefined,
    openBills: open.length,
    outstanding: round2(open.reduce((s, b) => s + b.balance, 0)),
    overdue: round2(overdue), overdueCount,
    dueNext7Days: round2(dueWeek), dueNext7DaysCount: dueWeekCount,
    aging,
    topVendors: [...byVendor.values()].sort((a, b) => b.amount - a.amount).slice(0, 5).map((v) => ({ ...v, amount: round2(v.amount) })),
    approvalQueue: { pending: queue.filter((q) => q.status === 'pending').length, postedToday: queue.filter((q) => q.status === 'posted' && q.posted?.at?.startsWith(asOf)).length },
  };
}

export async function listBills({ status = 'open', vendor, limit = 50, asOf = today() } = {}) {
  const L = ledger();
  let rows = await cached(status === 'all' ? 'bills' : 'openbills', () => L.listBills({ openOnly: status !== 'all' }), 60000);
  if (vendor) { const v = vendor.toLowerCase(); rows = rows.filter((b) => (b.vendorName || '').toLowerCase().includes(v)); }
  if (status === 'overdue') rows = rows.filter((b) => b.balance > 0 && b.dueDate < asOf);
  if (status === 'due_soon') rows = rows.filter((b) => b.balance > 0 && b.dueDate >= asOf && daysBetween(asOf, b.dueDate) <= 14);
  rows = [...rows].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  return { count: rows.length, total: round2(rows.reduce((s, b) => s + (status === 'all' ? b.total : b.balance), 0)), bills: rows.slice(0, Math.min(limit, 200)).map((b) => ({ ...b, daysOverdue: Math.max(0, daysBetween(b.dueDate, asOf)) })) };
}

export async function propose(input, { by = 'ai', source = 'chat' } = {}) {
  const c = await checkDraft(input);
  if (c.findings.some((x) => x.code === 'duplicate' || x.code === 'duplicate_queue' || x.code === 'duplicate_file')) {
    audit('proposal_refused', { by, reason: 'duplicate', number: c.draft.number, vendor: c.draft.vendor.name });
    return { queued: false, reason: 'This invoice is a duplicate, so it was not added to the approval queue.', checks: c };
  }
  const file = c.draft.fileId ? getFile(c.draft.fileId) : null;
  const item = queueAdd({ draft: c.draft, checks: { result: c.result, findings: c.findings, at: new Date().toISOString() }, proposedBy: by, source, file: file ? { id: file.sha, name: file.name, type: file.type } : null });
  audit('proposed', { by, id: item.id, vendor: c.draft.vendor.name, number: c.draft.number, total: c.draft.total, result: c.result });
  return { queued: true, id: item.id, status: 'pending', checks: c, note: 'Waiting for a person to approve it in the Approvals screen. Nothing has been posted.' };
}

export async function editQueued(qid, input, { by = 'user' } = {}) {
  const q = queueGet(qid);
  if (!q || q.status !== 'pending') throw new Error('Only pending items can be edited.');
  const c = await checkDraft({ ...input, file_id: q.draft.fileId }, { excludeQueueId: qid });
  queueUpdate(qid, { draft: c.draft, checks: { result: c.result, findings: c.findings, at: new Date().toISOString() } });
  audit('edited', { by, id: qid });
  return queueGet(qid);
}

export async function approve(qid, { by = 'user', acknowledgeWarnings = false } = {}) {
  const q = queueGet(qid);
  if (!q) throw new Error(`No approval item ${qid}`);
  if (q.status !== 'pending') throw new Error(`${qid} is ${q.status}, not pending.`);
  // Re-run the checks right before posting: the ledger may have changed since the bill was proposed.
  clearCache();
  const c = await checkDraft({ ...q.draft, file_id: q.draft.fileId }, { excludeQueueId: qid });
  queueUpdate(qid, { draft: c.draft, checks: { result: c.result, findings: c.findings, at: new Date().toISOString() } });
  if (c.result === 'blocked') throw new Error(`Can't post: ${c.findings.filter((x) => x.level === 'block').map((x) => x.message).join(' ')}`);
  if (c.result === 'review' && !acknowledgeWarnings) throw new Error(`Review needed first: ${c.findings.filter((x) => x.level === 'warn').map((x) => x.message).join(' ')}`);
  queueUpdate(qid, { status: 'posting' });
  try {
    const f = q.file ? getFile(q.file.id) : null;
    const res = await ledger().createBill(c.draft, f ? { name: f.name, type: f.type, data: readFile(f.sha) } : null);
    clearCache();
    queueUpdate(qid, { status: 'posted', posted: { at: new Date().toISOString(), by, ledger: ledger().key, ...res } });
    audit('posted', { by, id: qid, ledger: ledger().key, ledgerId: res.id, total: c.draft.total, acknowledgedWarnings: c.result === 'review' });
    return queueGet(qid);
  } catch (e) {
    queueUpdate(qid, { status: 'pending', lastError: e.message });
    audit('post_failed', { by, id: qid, error: e.message });
    throw e;
  }
}

export function reject(qid, { by = 'user', reason = '' } = {}) {
  const q = queueGet(qid);
  if (!q || q.status !== 'pending') throw new Error('Only pending items can be rejected.');
  queueUpdate(qid, { status: 'rejected', rejected: { at: new Date().toISOString(), by, reason } });
  audit('rejected', { by, id: qid, reason });
  return queueGet(qid);
}

export const queue = ({ status } = {}) => queueAll().filter((q) => !status || status === 'all' || q.status === status).slice(0, 100);
