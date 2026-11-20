// AI Ali web app. Plain JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, cur = '') => `${cur ? cur + ' ' : ''}${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let STATUS = null, CUR = '';

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = 'on' + (err ? ' err' : ''); clearTimeout(t._t); t._t = setTimeout(() => (t.className = ''), 3800); }

// Reads a newline-delimited JSON stream of agent progress.
async function streamPost(path, body, onEvent) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', last = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const ev = JSON.parse(line); onEvent(ev); last = ev; } }
  }
  if (last?.type === 'error') throw new Error(last.error);
  return last;
}

// Minimal markdown for chat answers: paragraphs, **bold**, `code`, lists, tables.
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = String(text || '').split('\n'); let out = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2; let body = '';
      while (i < lines.length && /^\s*\|/.test(lines[i])) { body += '<tr>' + row(lines[i]).map((c) => `<td${/^[-$€£A-Z]{0,4}\s?[\d,.]+$/.test(c) ? ' class="n"' : ''}>${inline(c)}</td>`).join('') + '</tr>'; i++; }
      out += `<table><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>${body}</table>`; continue;
    }
    if (/^\s*[-*] /.test(l)) { let items = ''; while (i < lines.length && /^\s*[-*] /.test(lines[i])) { items += `<li>${inline(lines[i].replace(/^\s*[-*] /, ''))}</li>`; i++; } out += `<ul>${items}</ul>`; continue; }
    if (/^\s*\d+\. /.test(l)) { let items = ''; while (i < lines.length && /^\s*\d+\. /.test(lines[i])) { items += `<li>${inline(lines[i].replace(/^\s*\d+\. /, ''))}</li>`; i++; } out += `<ol>${items}</ol>`; continue; }
    if (/^#{1,4} /.test(l)) { out += `<p><b>${inline(l.replace(/^#+ /, ''))}</b></p>`; i++; continue; }
    if (l.trim()) out += `<p>${inline(l)}</p>`;
    i++;
  }
  return out;
}
const TOOL_LABEL = { ap_summary: 'Reading the AP summary', list_bills: 'Listing bills', search_vendors: 'Looking up the vendor', list_accounts: 'Loading GL accounts and tax codes', list_purchase_orders: 'Checking purchase orders', check_invoice: 'Running AP checks', propose_bill: 'Adding the bill to Approvals', approval_queue: 'Reading the approval queue', approve_and_post: 'Posting the bill' };
const stepText = (ev) => {
  if (ev.type !== 'tool' && ev.type !== 'tool_result') return null;
  if (ev.type === 'tool') return `${TOOL_LABEL[ev.name] || ev.name}${ev.name === 'search_vendors' && ev.args?.query ? `: “${ev.args.query}”` : ''}…`;
  if (!ev.ok) return `${TOOL_LABEL[ev.name] || ev.name} failed: ${ev.error}`;
  if (ev.name === 'check_invoice') return `Checks: ${ev.out.result}${ev.out.findings?.length ? ` (${ev.out.findings.map((f) => f.code).join(', ')})` : ''}`;
  if (ev.name === 'propose_bill') return ev.out.queued ? `Queued for approval (${ev.out.id})` : `Not queued: ${ev.out.reason}`;
  return null;
};

// ---------------------------------------------------------------- navigation and status
const VIEWS = { overview: loadOverview, inbox: loadIntake, approvals: loadQueue, ask: () => {}, bills: loadBills, activity: loadAudit, settings: loadSettings };
function show() {
  const v = (location.hash || '#overview').slice(1).split('?')[0];
  const name = VIEWS[v] ? v : 'overview';
  $$('.view').forEach((s) => s.classList.toggle('on', s.id === `v-${name}`));
  $$('nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === name));
  Promise.resolve().then(VIEWS[name]).catch((e) => toast(e.message, true));
}
async function refreshStatus() {
  STATUS = await api('/api/status');
  const L = STATUS.ledger;
  CUR = L.currency || '';
  $('#company').textContent = L.company || L.label;
  $('#conn').innerHTML = `<div><span class="dot ${L.connected ? '' : 'off'}"></span><b>${esc(L.label)}</b> ${L.connected ? 'connected' : 'not connected'}</div>
    <div><span class="dot ${STATUS.ai.ready ? '' : 'off'}"></span><b>${STATUS.ai.provider === 'openai' ? 'OpenAI' : 'Claude'}</b> ${STATUS.ai.ready ? esc(STATUS.ai.model) : 'needs an API key'}</div>`;
  const b = $('#pending-badge'); b.hidden = !STATUS.queue.pending; b.textContent = STATUS.queue.pending;
}

// ---------------------------------------------------------------- overview
function notConnected(el, s) { el.innerHTML = `<div class="notice">${esc(s.error || 'The ledger is not connected.')} <a href="#settings">Open Settings</a></div>`; }
async function loadOverview() {
  const s = await api('/api/summary');
  if (s.error) { notConnected($('#kpis'), s); $('#aging').innerHTML = $('#topv').innerHTML = $('#soon').innerHTML = ''; return; }
  CUR = s.currency || CUR;
  $('#asof').textContent = `${s.info.company || ''} · as of ${s.asOf}${s.mixedCurrencies ? ` · mixed currencies (${s.mixedCurrencies.join(', ')}), totals are not converted` : ''}`;
  $('#kpis').innerHTML = [
    ['', 'Outstanding', s.outstanding, `${s.openBills} open bills`],
    ['red', 'Overdue', s.overdue, `${s.overdueCount} bills`],
    ['amber', 'Due next 7 days', s.dueNext7Days, `${s.dueNext7DaysCount} bills`],
    ['blue', 'Waiting approval', null, `<a href="#approvals">${s.approvalQueue.pending} pending →</a>`],
  ].map(([c, t, v, sub]) => `<div class="kpi ${c}"><small>${t}</small><b>${v == null ? s.approvalQueue.pending : fmt(v, s.currency)}</b><span>${sub}</span></div>`).join('');
  const max = Math.max(...s.aging.map((a) => a.amount), 1);
  $('#aging').innerHTML = `<div class="bars">${s.aging.map((a, i) => `<div class="bar"><span>${a.name}</span><div class="t"><i style="width:${(a.amount / max) * 100}%;background:${['#2f5bff', '#f0a52b', '#ea7a28', '#d9472b', '#a3161e'][i]}"></i></div><span class="v">${fmt(a.amount)}</span></div>`).join('')}</div>`;
  $('#topv').innerHTML = s.topVendors.length ? `<table>${s.topVendors.map((v) => `<tr><td>${esc(v.vendor)}<br><small class="muted">${v.count} bill${v.count > 1 ? 's' : ''}</small></td><td class="n">${fmt(v.amount)}</td></tr>`).join('')}</table>` : '<div class="empty">No open bills.</div>';
  const [od, ds] = await Promise.all([api('/api/bills?status=overdue'), api('/api/bills?status=due_soon')]);
  $('#soon').innerHTML = billTable([...od.bills, ...ds.bills]);
}
function billTable(rows, showTotal = false) {
  if (!rows.length) return '<div class="empty">Nothing here.</div>';
  return `<table><tr><th>Vendor</th><th>Bill #</th><th>Date</th><th>Due</th><th>Status</th><th class="n">${showTotal ? 'Total' : ''}</th><th class="n">Balance</th></tr>${rows.map((b) => `<tr><td>${esc(b.vendorName)}</td><td>${esc(b.number)}</td><td>${b.date}</td><td>${b.dueDate}</td><td>${b.daysOverdue > 0 && b.balance > 0 ? `<span class="pill late">${b.daysOverdue}d overdue</span>` : `<span class="pill ${esc(b.status)}">${esc(b.status)}</span>`}</td><td class="n">${showTotal ? fmt(b.total) : ''}</td><td class="n"><b>${fmt(b.balance, b.currency)}</b></td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- bills
let billFilter = 'open';
async function loadBills() {
  const r = await api(`/api/bills?status=${billFilter}`).catch((e) => ({ error: e.message }));
  if (r.error) return notConnected($('#bills'), r);
  $('#bills-sub').textContent = `${r.count} bills · ${fmt(r.total, CUR)} ${billFilter === 'all' ? 'billed' : 'outstanding'}`;
  $('#bills').innerHTML = billTable(r.bills, true);
}
$('#bfilter').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; billFilter = b.dataset.s; $$('#bfilter button').forEach((x) => x.classList.toggle('on', x === b)); loadBills(); };

// ---------------------------------------------------------------- inbox
const SAMPLES = [
  ['northwind-INV-10458.pdf', 'Office supplies (clean)'], ['peakit-PIT-5601.pdf', 'IT hardware with PO'], ['bowriver-BRC-2291.pdf', 'Cleaning (duplicate)'],
  ['chinook-catering-CC-0912.pdf', 'Catering (new vendor, odd tax)'], ['parkside-PL-3349.png', 'Landscaping photo (over PO)'],
];
$('#sample-btns').innerHTML = SAMPLES.map(([f, l]) => `<button data-f="${f}">${esc(l)}</button>`).join('');
$('#sample-btns').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const blob = await (await fetch(`/samples/${b.dataset.f}`)).blob();
  processFiles([new File([blob], b.dataset.f, { type: blob.type })]);
};
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => processFiles([...e.dataTransfer.files]));
$('#file').onchange = (e) => { processFiles([...e.target.files]); e.target.value = ''; };

async function processFiles(files) {
  if (!STATUS?.ai.ready) { toast('Add an AI API key in Settings first.', true); location.hash = '#settings'; return; }
  for (const f of files) await processOne(f); // one at a time keeps the order readable
  refreshStatus();
}
async function processOne(f) {
  const el = document.createElement('div'); el.className = 'run';
  el.innerHTML = `<div class="top"><i class="spin"></i>${esc(f.name)}<span class="r muted">Reading…</span></div><ul class="steps"></ul><div class="answer"></div>`;
  $('#runs').prepend(el);
  const steps = $('.steps', el), top = $('.top .r', el);
  try {
    const up = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': f.type || 'application/pdf', 'x-filename': encodeURIComponent(f.name) }, body: f }).then((r) => r.json());
    if (up.error) throw new Error(up.error);
    let queued = null;
    const done = await streamPost('/api/process', { fileId: up.id }, (ev) => {
      const t = stepText(ev); if (t) { const li = document.createElement('li'); li.textContent = t; if (ev.ok === false) li.className = 'err'; steps.append(li); }
      if (ev.name === 'propose_bill' && ev.out?.queued) queued = ev.out;
    });
    $('.spin', el).replaceWith(Object.assign(document.createElement('span'), { className: `pill ${queued ? queued.result : 'blocked'}`, textContent: queued ? 'In approvals' : 'Not queued' }));
    top.innerHTML = queued ? `<a href="#approvals">Review →</a>` : '';
    $('.answer', el).innerHTML = md(done.answer);
  } catch (e) {
    $('.spin', el)?.remove(); top.textContent = ''; $('.answer', el).innerHTML = `<div class="notice">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- automatic intake
const RESULT = { queued: ['pass', 'In approvals'], not_invoice: ['', 'Not an invoice'], not_queued: ['blocked', 'Not queued'], no_action: ['', 'No action'], already_seen: ['', 'Already seen'], error: ['blocked', 'Error'], warning: ['review', 'Warning'] };
const ago = (iso) => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : iso.slice(0, 10); };
async function loadIntake() {
  const r = await api('/api/intake');
  $('#intake-sources').innerHTML = Object.entries(r.sources).map(([k, s]) => `<div class="src ${s.lastError ? 'err' : ''}"><b><span class="dot ${s.connected && !s.lastError ? '' : 'off'}"></span>${esc(s.label)}</b>
    ${s.connected ? `<small>${esc(s.account)}</small><small>Checked ${ago(s.lastCheck)} · ${s.processed} picked up</small>${s.lastError ? `<small class="e">${esc(s.lastError)}</small>` : ''}` : `<small>Not connected · <a href="#settings">set up</a></small>`}</div>`).join('');
  $('#intake-run').disabled = r.running;
  $('#intake-log').innerHTML = r.log.length ? `<table><tr><th>When</th><th>Source</th><th>File</th><th>From / subject</th><th>Result</th></tr>${r.log.slice(0, 25).map((l) => {
    let [cls, label] = RESULT[l.result] || ['', l.result];
    if (l.result === 'queued' && l.checks && l.checks !== 'pass') { cls = l.checks; label = l.checks === 'review' ? 'In approvals · review' : 'In approvals · blocked'; }
    return `<tr><td>${ago(l.at)}</td><td>${esc(l.source)}</td><td>${esc(l.file || '')}</td><td class="muted">${esc(l.from || '')}${l.subject ? `<br>${esc(l.subject)}` : ''}</td><td><span class="pill ${cls}">${label}</span>${l.queueId ? ` <a href="#approvals">review</a>` : ''}${l.message && l.result !== 'queued' ? `<br><small class="muted">${esc(l.message.slice(0, 160))}</small>` : ''}</td></tr>`;
  }).join('')}</table>` : '<div class="empty">Nothing picked up yet.</div>';
}
$('#intake-run').onclick = async () => {
  if (!STATUS?.ai.ready) { toast('Add an AI API key in Settings first.', true); return; }
  const b = $('#intake-run'); b.disabled = true; b.textContent = 'Checking…';
  try {
    const done = await streamPost('/api/intake/run', {}, (ev) => { if (ev.type === 'intake_file') b.textContent = `Reading ${ev.name}…`; });
    const r = done.results || [];
    toast(r.length ? r.map((x) => `${x.source}: ${x.error ? 'error' : `${x.processed} new, ${x.queued} queued`}`).join(' · ') : 'No sources connected.', r.some((x) => x.error));
  } catch (e) { toast(e.message, true); }
  b.textContent = 'Check now'; await loadIntake(); refreshStatus();
};

// ---------------------------------------------------------------- approvals
let qFilter = 'pending', LOOK = null;
$('#qfilter').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; qFilter = b.dataset.s; $$('#qfilter button').forEach((x) => x.classList.toggle('on', x === b)); loadQueue(); };
async function loadQueue() {
  const [q] = await Promise.all([api(`/api/queue?status=${qFilter}`), refreshStatus()]);
  if (!LOOK) LOOK = await api('/api/lookups').catch(() => ({ vendors: [], accounts: [], taxCodes: [] }));
  $('#queue').innerHTML = q.items.length ? q.items.map(card).join('') : `<div class="card empty">${qFilter === 'pending' ? 'Nothing waiting for approval. Drop invoices in the <a href="#inbox">Inbox</a>.' : 'Nothing here.'}</div>`;
}
function card(q) {
  const d = q.draft, edit = q.status === 'pending', dis = edit ? '' : 'disabled';
  const acct = (sel) => `<select data-k="accountId" ${dis}><option value="">Choose account…</option>${LOOK.accounts.map((a) => `<option value="${esc(a.id)}" ${String(a.id) === String(sel) ? 'selected' : ''}>${esc(a.code ? `${a.code} · ${a.name}` : a.name)}</option>`).join('')}</select>`;
  const tax = (sel) => LOOK.taxCodes.length ? `<select data-k="taxCode" ${dis}><option value="">—</option>${LOOK.taxCodes.map((t) => `<option value="${esc(t.id)}" ${String(t.id) === String(sel) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : '';
  const hasWarn = q.checks.result === 'review', blocked = q.checks.result === 'blocked';
  const posted = q.posted ? `Posted ${q.posted.at.slice(0, 16).replace('T', ' ')} to ${q.posted.ledger === 'qbo' ? 'QuickBooks' : q.posted.ledger === 'xero' ? 'Xero' : 'the demo ledger'} as ${esc(q.posted.id)}${q.posted.url ? ` · <a href="${esc(q.posted.url)}" target="_blank" rel="noopener">open</a>` : ''}${(q.posted.warnings || []).map((w) => `<br>⚠ ${esc(w)}`).join('')}` : '';
  return `<div class="q" data-id="${q.id}">
    <div class="qh"><span class="pill ${q.status === 'pending' ? q.checks.result : q.status}">${q.status === 'pending' ? { pass: 'Checks passed', review: 'Needs review', blocked: 'Blocked' }[q.checks.result] : q.status}</span>
      <div><b>${esc(d.vendor.name)}</b><br><small class="muted">${esc(d.number)} · proposed by ${esc(q.proposedBy)} · ${q.created.slice(0, 16).replace('T', ' ')}</small></div>
      ${q.file ? `<a class="link" href="/api/queue/${q.id}/file" target="_blank" rel="noopener">View invoice</a>` : ''}<span class="amt">${fmt(d.total, d.currency || CUR)}</span></div>
    <div class="qb"><div class="fields">
      <label>Vendor<select data-f="vendor" ${dis}><option value="">New vendor: ${esc(d.vendor.name)}</option>${LOOK.vendors.map((v) => `<option value="${esc(v.id)}" ${String(v.id) === String(d.vendor.id) ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
      <label>Invoice #<input data-f="number" value="${esc(d.number)}" ${dis}></label>
      <label>Invoice date<input data-f="date" type="date" value="${esc(d.date)}" ${dis}></label>
      <label>Due date<input data-f="dueDate" type="date" value="${esc(d.dueDate)}" ${dis}></label>
      <label>PO number<input data-f="poNumber" value="${esc(d.poNumber || '')}" ${dis}></label>
      <label>Currency<input data-f="currency" value="${esc(d.currency || '')}" ${dis}></label>
      <label>Tax<input data-f="tax" type="number" step="0.01" value="${d.tax}" ${dis}></label>
      <label>Total<input data-f="total" type="number" step="0.01" value="${d.total}" ${dis}></label>
      ${d.notes ? `<label style="grid-column:1/-1">Agent notes<span style="font-weight:400;color:var(--ink)">${esc(d.notes)}</span></label>` : ''}
    </div><div class="lines"><table><tr><th>Line</th><th>Account</th>${LOOK.taxCodes.length ? '<th>Tax</th>' : ''}<th class="n">Amount</th></tr>
      ${d.lines.map((l) => `<tr class="ln"><td><input data-k="description" value="${esc(l.description)}" ${dis}></td><td>${acct(l.accountId)}</td>${LOOK.taxCodes.length ? `<td>${tax(l.taxCode)}</td>` : ''}<td><input data-k="amount" type="number" step="0.01" value="${l.amount}" style="text-align:right;width:110px" ${dis}></td></tr>`).join('')}
    </table></div></div>
    ${q.checks.findings.length ? `<ul class="findings">${q.checks.findings.map((f) => `<li class="${f.level}">${esc(f.message)}</li>`).join('')}</ul>` : ''}
    <div class="qf">${edit ? `${hasWarn ? `<label class="ack"><input type="checkbox" class="ackbox"> I've reviewed the warnings</label>` : `<span class="meta">${blocked ? 'Fix the blocking issues, then save.' : 'All checks passed.'}${q.lastError ? ` Last attempt failed: ${esc(q.lastError)}` : ''}</span>`}
      <button class="btn ghost sm" data-a="save">Save edits</button><button class="btn danger sm" data-a="reject">Reject</button><button class="btn sm" data-a="approve" ${blocked ? 'disabled' : ''}>Approve &amp; post</button>`
      : `<span class="meta">${posted || (q.rejected ? `Rejected ${q.rejected.at.slice(0, 16).replace('T', ' ')}${q.rejected.reason ? `: ${esc(q.rejected.reason)}` : ''}` : '')}</span>`}</div>
  </div>`;
}
function readCard(el) {
  const f = (k) => $(`[data-f="${k}"]`, el).value.trim();
  const vid = f('vendor'); const v = LOOK.vendors.find((x) => String(x.id) === vid);
  const orig = el._draft;
  return {
    vendor_id: vid || undefined, vendor_name: v ? v.name : orig.vendor.name, invoice_number: f('number'), invoice_date: f('date'), due_date: f('dueDate'),
    po_number: f('poNumber') || undefined, currency: f('currency') || undefined, tax: Number(f('tax')), total: Number(f('total')),
    subtotal: undefined, notes: orig.notes,
    lines: $$('.ln', el).map((r) => ({ description: $('[data-k="description"]', r).value, amount: Number($('[data-k="amount"]', r).value), account_id: $('[data-k="accountId"]', r).value, tax_code: $('[data-k="taxCode"]', r)?.value || undefined })),
  };
}
$('#queue').onclick = async (e) => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const el = b.closest('.q'), id = el.dataset.id;
  const items = (await api(`/api/queue?status=all`)).items; el._draft = items.find((x) => x.id === id).draft;
  b.disabled = true;
  try {
    if (b.dataset.a === 'save') { await post(`/api/queue/${id}/edit`, { draft: readCard(el) }); toast('Saved and re-checked.'); }
    if (b.dataset.a === 'reject') { const reason = prompt('Reason for rejecting (optional):'); if (reason === null) return; await post(`/api/queue/${id}/reject`, { reason }); toast('Rejected.'); }
    if (b.dataset.a === 'approve') {
      await post(`/api/queue/${id}/edit`, { draft: readCard(el) });
      const r = await post(`/api/queue/${id}/approve`, { acknowledgeWarnings: !!$('.ackbox', el)?.checked });
      toast(`Posted to ${STATUS.ledger.label} as ${r.posted.id}.`);
    }
    LOOK = null; await loadQueue();
  } catch (err) { toast(err.message, true); LOOK = null; await loadQueue(); } finally { b.disabled = false; }
};

// ---------------------------------------------------------------- ask
let sessionId = null;
const CHIPS = ['Give me the AP summary', "What's overdue and by how much?", 'What do we need to pay in the next 14 days?', 'Which vendors have open POs?', 'What is waiting for approval?'];
$('#chips').innerHTML = CHIPS.map((c) => `<button>${esc(c)}</button>`).join('');
$('#chips').onclick = (e) => { const b = e.target.closest('button'); if (b) ask(b.textContent); };
$('#composer').onsubmit = (e) => { e.preventDefault(); const t = $('#msg').value.trim(); if (t) { $('#msg').value = ''; ask(t); } };
$('#msg').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } };
async function ask(text) {
  if (!STATUS?.ai.ready) { toast('Add an AI API key in Settings first.', true); location.hash = '#settings'; return; }
  const chat = $('#chat');
  chat.insertAdjacentHTML('beforeend', `<div class="msg u">${esc(text)}</div>`);
  const a = document.createElement('div'); a.className = 'msg a'; a.innerHTML = '<ul class="steps"><li><i class="spin"></i></li></ul><div class="answer"></div>'; chat.append(a);
  a.scrollIntoView({ behavior: 'smooth', block: 'end' });
  const steps = $('.steps', a); steps.innerHTML = '';
  try {
    const done = await streamPost('/api/chat', { sessionId, text }, (ev) => { const t = stepText(ev); if (t && ev.type === 'tool') { const li = document.createElement('li'); li.textContent = t; steps.append(li); } });
    sessionId = done.sessionId;
    $('.answer', a).innerHTML = md(done.answer);
  } catch (e) { $('.answer', a).innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  a.scrollIntoView({ behavior: 'smooth', block: 'end' });
  refreshStatus();
}

// ---------------------------------------------------------------- activity
async function loadAudit() {
  const r = await api('/api/audit');
  const label = { proposed: 'Proposed', posted: 'Posted', rejected: 'Rejected', edited: 'Edited', post_failed: 'Posting failed', proposal_refused: 'Refused (duplicate)', settings_changed: 'Settings changed', connected: 'Connected', disconnected: 'Disconnected', demo_reset: 'Demo reset' };
  $('#audit').innerHTML = r.events.length ? `<table><tr><th>When</th><th>Event</th><th>By</th><th>Detail</th></tr>${r.events.map((e) => {
    const { at, event, by, ...rest } = e;
    const detail = Object.entries(rest).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
    return `<tr><td>${at.slice(0, 19).replace('T', ' ')}</td><td><b>${label[event] || event}</b></td><td>${esc(by || '')}</td><td class="muted">${esc(detail)}</td></tr>`;
  }).join('')}</table>` : '<div class="empty">No activity yet.</div>';
}

// ---------------------------------------------------------------- settings
async function loadSettings() {
  const [s] = await Promise.all([api('/api/settings'), refreshStatus()]);
  const st = STATUS;
  $$('input[name="LEDGER"]').forEach((r) => (r.checked = r.value === s.LEDGER));
  $$('input[name="AI_PROVIDER"]').forEach((r) => (r.checked = r.value === s.AI_PROVIDER));
  $('[name="PO_TOLERANCE_PCT"]').value = s.PO_TOLERANCE_PCT; $('[name="COMPANY_NAME"]').value = s.COMPANY_NAME || '';
  $('[name="ALLOW_AI_POSTING"]').checked = /^(1|true|yes|on)$/i.test(s.ALLOW_AI_POSTING);
  $('[name="INTAKE_INTERVAL_MIN"]').value = s.INTAKE_INTERVAL_MIN; $('[name="INTAKE_MAX_PER_RUN"]').value = s.INTAKE_MAX_PER_RUN;
  $('[name="INTAKE_ENABLED"]').checked = /^(1|true|yes|on)$/i.test(s.INTAKE_ENABLED);
  renderLedger(s, st); renderAI(s); renderSources(s, st); renderConnector(st);
}
function renderLedger(s, st) {
  const L = s.LEDGER, el = $('#ledger-detail');
  if (L === 'demo') { el.innerHTML = `<div class="status-line"><span class="dot"></span>Using the demo ledger: ${esc(st.ledger.company || '')}.</div>`; return; }
  const q = L === 'qbo';
  const pfx = q ? 'QBO' : 'XERO';
  const connected = q ? st.oauth.qboConnected : st.oauth.xeroConnected;
  const ready = q ? st.oauth.qboReady : st.oauth.xeroReady;
  el.innerHTML = `
    <div class="status-line"><span class="dot ${st.ledger.key === L && st.ledger.connected ? '' : 'off'}"></span>${st.ledger.key === L && st.ledger.connected ? `Connected to <b>${esc(st.ledger.company)}</b>` : connected ? `Signed in, but the connection failed: ${esc(st.ledger.error || '')}` : 'Not connected yet.'}</div>
    <div class="steps-box"><b>How to connect ${q ? 'QuickBooks Online' : 'Xero'}</b><ol>
      ${q ? `<li>Sign in at <a href="https://developer.intuit.com" target="_blank" rel="noopener">developer.intuit.com</a> and create an app (QuickBooks Online and Payments, Accounting scope). A free sandbox company comes with it.</li>`
          : `<li>Sign in at <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener">developer.xero.com/app/manage</a> and create a <b>Web app</b>. Use the Xero demo company to test.</li>`}
      <li>Add this redirect URI to the app:<div class="copy"><code>${esc(q ? st.oauth.qboRedirect : st.oauth.xeroRedirect)}</code><button class="btn ghost sm" data-copy="${esc(q ? st.oauth.qboRedirect : st.oauth.xeroRedirect)}">Copy</button></div></li>
      <li>Paste the client id and secret below, save, then click Connect.</li>
      ${q ? '' : `<li>Scopes requested (granular, as Xero requires for new apps): <code>${esc(st.oauth.xeroScopes)}</code></li>`}
    </ol></div>
    <div class="form">
      <label>Client ID<input name="${pfx}_CLIENT_ID" value="${esc(s[pfx + '_CLIENT_ID'] || '')}"></label>
      <label>Client secret<input name="${pfx}_CLIENT_SECRET" type="password" placeholder="${s[pfx + '_CLIENT_SECRET'] ? esc(s[pfx + '_CLIENT_SECRET']) + ' (saved)' : ''}"></label>
      ${q ? `<label>Environment<select name="QBO_ENVIRONMENT"><option value="sandbox" ${s.QBO_ENVIRONMENT === 'sandbox' ? 'selected' : ''}>Sandbox</option><option value="production" ${s.QBO_ENVIRONMENT === 'production' ? 'selected' : ''}>Production</option></select></label>
            <label>Default tax code id (optional)<input name="QBO_DEFAULT_TAX_CODE" value="${esc(s.QBO_DEFAULT_TAX_CODE || '')}"><small>For companies outside the US. Leave empty for US companies.</small></label>`
        : `<label>Bill status after approval<select name="XERO_BILL_STATUS"><option value="AUTHORISED" ${s.XERO_BILL_STATUS !== 'DRAFT' ? 'selected' : ''}>Awaiting payment (authorised)</option><option value="DRAFT" ${s.XERO_BILL_STATUS === 'DRAFT' ? 'selected' : ''}>Draft in Xero</option></select></label>`}
    </div>
    <button class="btn ghost" data-save-ledger>Save</button> <a class="btn" href="/oauth/${L}/start" ${ready ? '' : 'style="opacity:.5;pointer-events:none"'}>${connected ? 'Reconnect' : 'Connect'} ${q ? 'QuickBooks' : 'Xero'}</a>
    ${connected ? ` <button class="btn danger" data-disconnect="${L}">Disconnect</button>` : ''}`;
}
function renderAI(s) {
  const o = s.AI_PROVIDER === 'openai';
  const k = o ? 'OPENAI' : 'ANTHROPIC';
  $('#ai-form').innerHTML = `
    <label>${o ? 'OpenAI' : 'Anthropic'} API key<input name="${k}_API_KEY" type="password" autocomplete="off" placeholder="${s[k + '_API_KEY'] ? esc(s[k + '_API_KEY']) + ' (saved)' : o ? 'sk-…' : 'sk-ant-…'}"><small>Get one at ${o ? '<a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>' : '<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>'}. Usage is billed by ${o ? 'OpenAI' : 'Anthropic'} to your account.</small></label>
    <label>Model<input name="${k}_MODEL" value="${esc(s[k + '_MODEL'])}"><small>Any model that supports tools and PDF input.</small></label>
    <div class="wide"><button class="btn" data-save-ai>Save AI settings</button></div>`;
}
function renderSources(s, st) {
  const I = st.intake, src = I.sources;
  const line = (k) => `<span class="dot ${src[k].connected && !src[k].lastError ? '' : 'off'}"></span>`;
  const copy = (u) => `<div class="copy"><code>${esc(u)}</code><button class="btn ghost sm" data-copy="${esc(u)}">Copy</button></div>`;
  $('#sources-detail').innerHTML = `
  <div class="srcbox"><h3>${line('gmail')}Gmail ${src.gmail.connected ? `<small class="muted">· ${esc(src.gmail.account)}</small>` : ''}</h3>
    <div class="steps-box"><ol>
      <li>In <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Google Cloud console</a>, enable the <b>Gmail API</b>.</li>
      <li>Create an OAuth client (type <b>Web application</b>) with this redirect URI:${copy(I.gmailRedirect)}</li>
      <li>On the consent screen, choose <b>Internal</b> if you use Google Workspace. For a personal Gmail, set it to <b>In production</b>: in Testing mode Google ends the access every 7 days.</li>
      <li>Paste the client id and secret, save, then Connect. Access is read-only (<code>gmail.readonly</code>).</li></ol></div>
    <div class="form"><label>Client ID<input name="GMAIL_CLIENT_ID" value="${esc(s.GMAIL_CLIENT_ID || '')}"></label>
      <label>Client secret<input name="GMAIL_CLIENT_SECRET" type="password" placeholder="${s.GMAIL_CLIENT_SECRET ? esc(s.GMAIL_CLIENT_SECRET) + ' (saved)' : ''}"></label>
      <label class="wide">Which emails (Gmail search)<input name="GMAIL_QUERY" value="${esc(s.GMAIL_QUERY || '')}"><small>For example add <code>to:ap@yourcompany.com</code> or <code>label:invoices</code> to narrow it down.</small></label></div>
    <button class="btn ghost" data-save-src>Save</button> <a class="btn" href="/oauth/gmail/start" ${I.gmailReady ? '' : 'style="opacity:.5;pointer-events:none"'}>${src.gmail.connected ? 'Reconnect' : 'Connect'} Gmail</a>${src.gmail.connected ? ' <button class="btn danger" data-disconnect="gmail">Disconnect</button>' : ''}
  </div>
  <div class="srcbox"><h3>${line('outlook')}Outlook / Microsoft 365 ${src.outlook.connected ? `<small class="muted">· ${esc(src.outlook.account)}</small>` : ''}</h3>
    <div class="steps-box"><ol>
      <li>In <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra → App registrations</a>, create a new registration. Pick the account types you need (work, personal, or both) and add a <b>Web</b> redirect URI:${copy(I.outlookRedirect)}</li>
      <li>Under Certificates &amp; secrets, create a client secret. Under API permissions, add Microsoft Graph delegated <b>Mail.Read</b>.</li>
      <li>Paste the application (client) id and secret, save, then Connect.</li></ol></div>
    <div class="form"><label>Application (client) ID<input name="OUTLOOK_CLIENT_ID" value="${esc(s.OUTLOOK_CLIENT_ID || '')}"></label>
      <label>Client secret<input name="OUTLOOK_CLIENT_SECRET" type="password" placeholder="${s.OUTLOOK_CLIENT_SECRET ? esc(s.OUTLOOK_CLIENT_SECRET) + ' (saved)' : ''}"></label>
      <label>Tenant<input name="OUTLOOK_TENANT" value="${esc(s.OUTLOOK_TENANT || 'common')}"><small><code>common</code> for work and personal accounts, or your tenant id.</small></label>
      <label>Mail folder<input name="OUTLOOK_FOLDER" value="${esc(s.OUTLOOK_FOLDER || 'inbox')}"><small><code>inbox</code>, or a folder id.</small></label></div>
    <button class="btn ghost" data-save-src>Save</button> <a class="btn" href="/oauth/outlook/start" ${I.outlookReady ? '' : 'style="opacity:.5;pointer-events:none"'}>${src.outlook.connected ? 'Reconnect' : 'Connect'} Outlook</a>${src.outlook.connected ? ' <button class="btn danger" data-disconnect="outlook">Disconnect</button>' : ''}
  </div>
  <div class="srcbox"><h3>${line('folder')}Folder on this computer</h3>
    <p class="muted">Any PDF or image saved in this folder is picked up, including scanner output or a synced OneDrive, Google Drive or Dropbox folder. Files are recognised by their content, so renaming one won't process it twice.</p>
    <div class="form"><label class="wide">Folder path<input name="WATCH_FOLDER" value="${esc(s.WATCH_FOLDER || '')}" placeholder="C:\\Users\\you\\Documents\\Invoices   or   ~/Invoices"></label>
      <label class="check"><input type="checkbox" name="MOVE_PROCESSED" ${/^(1|true|yes|on)$/i.test(s.MOVE_PROCESSED) ? 'checked' : ''}><span>Move picked-up files into a "processed" subfolder</span></label></div>
    <button class="btn ghost" data-save-src>Save</button>${src.folder.lastError ? ` <span class="pill blocked">${esc(src.folder.lastError)}</span>` : ''}
  </div>`;
}
function renderConnector(st) {
  const url = st.connector.url;
  $('#connector').innerHTML = `
    <label class="muted" style="display:block;margin:0 0 2px">Connector URL (keep it private: it works like a password)</label>
    <div class="copy"><code>${esc(url)}</code><button class="btn ghost sm" data-copy="${esc(url)}">Copy</button></div>
    ${st.connector.local ? `<div class="notice">Claude.ai and ChatGPT need an HTTPS address they can reach. Deploy this app, or run a tunnel (for example <code>cloudflared tunnel --url ${esc(location.origin)}</code>) and set <code>PUBLIC_URL</code> in .env. For Claude Desktop or Claude Code, the local option below works without any of that.</div>` : ''}
    <div class="steps-box"><b>Claude (claude.ai or desktop)</b><ol><li>Settings → Connectors → Add custom connector.</li><li>Paste the connector URL. No sign-in is needed: the secret is in the URL.</li></ol></div>
    <div class="steps-box"><b>ChatGPT</b><ol><li>Turn on Developer mode (Settings → Apps &amp; Connectors → Advanced settings).</li><li>Create a custom connector, paste the URL, authentication: none.</li></ol></div>
    <div class="steps-box"><b>Claude Desktop or Claude Code, fully local</b> (no URL, runs on this computer)<pre class="code">${esc(JSON.stringify({ mcpServers: { 'ai-ali': { command: 'node', args: ['/full/path/to/ai-ali/src/mcp-stdio.js'] } } }, null, 2))}</pre>Claude Code: <code>claude mcp add ai-ali -- node /full/path/to/ai-ali/src/mcp-stdio.js</code></div>
    <p class="muted" style="margin:0">Tools: ${st.connector.tools.map((t) => `<code>${t}</code>`).join(' ')}</p>`;
}
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]'); if (c) { await navigator.clipboard.writeText(c.dataset.copy).catch(() => {}); toast('Copied.'); return; }
  const card = e.target.closest('.card');
  if (e.target.closest('[data-save-ledger]') || e.target.closest('[data-save-ai]') || e.target.closest('[data-save-src]')) {
    const scope = e.target.closest('.srcbox') || card;
    const body = {}; $$('input[name],select[name]', scope).forEach((i) => { if (i.type === 'radio') { if (i.checked) body[i.name] = i.value; } else if (i.type === 'checkbox') body[i.name] = i.checked ? 'true' : 'false'; else if (i.type === 'password') { if (i.value) body[i.name] = i.value; } else body[i.name] = i.value; });
    try { await post('/api/settings', body); toast('Saved.'); LOOK = null; loadSettings(); } catch (err) { toast(err.message, true); }
  }
  const d = e.target.closest('[data-disconnect]');
  if (d && confirm('Disconnect? You can reconnect any time.')) { await post('/api/disconnect', { ledger: d.dataset.disconnect }); toast('Disconnected.'); loadSettings(); }
});
$('#ledger-opts').onchange = async (e) => { await post('/api/settings', { LEDGER: e.target.value }); LOOK = null; toast('Ledger switched.'); loadSettings(); };
$('#ai-opts').onchange = async (e) => { await post('/api/settings', { AI_PROVIDER: e.target.value }); sessionId = null; loadSettings(); };
$('#save-controls').onclick = async () => {
  await post('/api/settings', { PO_TOLERANCE_PCT: $('[name="PO_TOLERANCE_PCT"]').value, COMPANY_NAME: $('[name="COMPANY_NAME"]').value, ALLOW_AI_POSTING: $('[name="ALLOW_AI_POSTING"]').checked ? 'true' : 'false',
    INTAKE_INTERVAL_MIN: $('[name="INTAKE_INTERVAL_MIN"]').value, INTAKE_MAX_PER_RUN: $('[name="INTAKE_MAX_PER_RUN"]').value, INTAKE_ENABLED: $('[name="INTAKE_ENABLED"]').checked ? 'true' : 'false' });
  toast('Controls saved.'); loadSettings();
};
$('#reset-demo').onclick = async () => { if (!confirm('Reset the demo ledger? Bills you posted to it will be removed.')) return; await post('/api/demo/reset'); LOOK = null; toast('Demo ledger reset.'); };

window.addEventListener('hashchange', show);
refreshStatus().then(show).catch((e) => toast(e.message, true));
