// Automatic intake: checks Gmail, Outlook and a watched folder for new invoices, and runs each one through the agent.
// Every invoice still goes to Approvals. Nothing is posted by the intake itself.
import { get, bool, num } from '../config.js';
import * as store from '../store.js';
import { runTurn, provider } from '../agent.js';
import { gmail } from './gmail.js';
import { outlook } from './outlook.js';
import { folder } from './folder.js';

export const SOURCES = { gmail, outlook, folder };
const EXT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const MIN_IMAGE_BYTES = 30 * 1024; // smaller images in emails are almost always logos and signatures
const MAX_BYTES = 20 * 1024 * 1024;
let running = null;

function fileType(item) {
  const t = String(item.type || '').toLowerCase().split(';')[0];
  if (store.ACCEPTED_TYPES.includes(t)) return t;
  return EXT[String(item.name || '').split('.').pop().toLowerCase()] || null; // e.g. "application/octet-stream" with a .pdf name
}

export function status() {
  return Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => {
    const st = store.intakeSource(k);
    return [k, { label: s.label, connected: s.connected(), account: s.account(), lastCheck: st.lastCheck || null, lastOk: st.lastOk || null, lastError: st.lastError || null, processed: st.processed || 0 }];
  }));
}

export async function runSource(key, { onEvent = () => {} } = {}) {
  const src = SOURCES[key];
  if (!src?.connected()) return { source: key, skipped: 'not connected' };
  const st = store.intakeSource(key);
  const lookback = Math.max(1, num('INTAKE_LOOKBACK_DAYS') || 3);
  const since = st.lastOk ? new Date(Date.parse(st.lastOk) - 2 * 86400000) : new Date(Date.now() - lookback * 86400000);
  const max = num('INTAKE_MAX_PER_RUN') || 20;
  const res = { source: key, found: 0, processed: 0, queued: 0, skipped: 0, errors: 0 };
  store.setIntakeSource(key, { lastCheck: new Date().toISOString() });
  try {
    for await (const item of src.fetch({ since })) {
      if (item.key && store.intakeSeen(item.key)) continue;
      const type = fileType(item);
      if (!type || (item.inline && type.startsWith('image/')) || (type.startsWith('image/') && item.size && item.size < MIN_IMAGE_BYTES) || item.size > MAX_BYTES) {
        if (item.key) store.intakeMarkSeen(item.key);
        continue;
      }
      res.found++;
      if (res.processed >= max) { res.skipped++; continue; } // left for the next check
      const data = await item.load();
      if (type.startsWith('image/') && data.length < MIN_IMAGE_BYTES) { if (item.key) store.intakeMarkSeen(item.key); continue; }
      const f = store.saveFile(data, item.name, type);
      if (store.intakeSeen(`sha:${f.sha}`)) {
        if (item.key) store.intakeMarkSeen(item.key);
        item.done?.();
        store.intakeLog({ source: key, file: item.name, from: item.from, subject: item.subject, result: 'already_seen', message: 'Same file was already picked up.' });
        continue;
      }
      onEvent({ type: 'intake_file', source: key, name: item.name });
      res.processed++;
      let out;
      try {
        out = await runTurn({
          text: `Process this invoice. It arrived by ${src.label}${item.from ? ` from ${item.from}` : ''}${item.subject ? `, subject "${item.subject}"` : ''}.
If the file is not a supplier invoice or bill (for example a statement of account, payment receipt, quote, purchase order, remittance or marketing), do not propose anything and start your reply with "NOT AN INVOICE:" and the reason.`,
          file: { name: f.name, type: f.type, data }, fileId: f.sha, source: `intake:${key}`, onEvent,
        });
      } catch (e) {
        // AI or ledger unavailable: keep the file unseen so the next check retries it, and stop this run.
        res.errors++;
        store.intakeLog({ source: key, file: item.name, from: item.from, subject: item.subject, result: 'error', message: e.message });
        throw e;
      }
      const prop = out.actions.find((a) => a.tool === 'propose_bill' && a.ok);
      const entry = { source: key, file: item.name, fileId: f.sha, from: item.from, subject: item.subject };
      if (prop?.out?.queued) { res.queued++; store.intakeLog({ ...entry, result: 'queued', queueId: prop.out.id, checks: prop.out.result, message: out.answer.slice(0, 400) }); }
      else if (/^\s*\**NOT AN INVOICE/i.test(out.answer)) store.intakeLog({ ...entry, result: 'not_invoice', message: out.answer.replace(/^\s*\**NOT AN INVOICE:?\**\s*/i, '').slice(0, 300) });
      else store.intakeLog({ ...entry, result: prop ? 'not_queued' : 'no_action', message: (prop?.out?.reason || out.answer).slice(0, 400) });
      store.intakeMarkSeen(`sha:${f.sha}`);
      if (item.key) store.intakeMarkSeen(item.key);
      try { item.done?.(); } catch (e) { store.intakeLog({ ...entry, result: 'warning', message: `Couldn't move the file: ${e.message}` }); }
    }
    store.setIntakeSource(key, { lastOk: new Date().toISOString(), lastError: null, processed: (st.processed || 0) + res.processed });
  } catch (e) {
    store.setIntakeSource(key, { lastError: e.message, processed: (st.processed || 0) + res.processed });
    res.error = e.message;
  }
  return res;
}

// One check across every connected source. Only one check runs at a time.
export function runAll(opts = {}) {
  if (running) return running;
  running = (async () => {
    const results = [];
    for (const k of Object.keys(SOURCES)) if (SOURCES[k].connected()) results.push(await runSource(k, opts));
    return results;
  })().finally(() => { running = null; });
  return running;
}
export const isRunning = () => !!running;

let timer = null, lastRun = 0;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    if (!bool('INTAKE_ENABLED') || !provider().ready() || running) return;
    if (!Object.values(SOURCES).some((s) => s.connected())) return;
    const every = Math.max(1, num('INTAKE_INTERVAL_MIN') || 5) * 60000;
    if (Date.now() - lastRun < every) return;
    lastRun = Date.now();
    runAll().catch(() => {});
  }, 30000);
  timer.unref?.();
}
