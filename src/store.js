// Local state: the approval queue, uploaded invoice files, OAuth tokens and an audit log. Plain JSON files in data/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'state.json');
const UPLOADS = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = {}; }
  state.queue ??= [];
  state.tokens ??= {};
  state.audit ??= [];
  state.files ??= {};
  return state;
}
function persist() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
export const now = () => new Date().toISOString();

// ---- audit log: every proposal, approval, rejection and posting, with who/what did it
export function audit(event, detail = {}) {
  load().audit.unshift({ at: now(), event, ...detail });
  state.audit = state.audit.slice(0, 2000);
  persist();
}
export const auditLog = (n = 200) => load().audit.slice(0, n);

// ---- invoice files
const EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const ACCEPTED_TYPES = Object.keys(EXT);
export function saveFile(buf, name, type) {
  if (!EXT[type]) throw new Error(`Unsupported file type ${type}. Use PDF, PNG, JPG, WEBP or GIF.`);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const file = path.join(UPLOADS, `${sha}.${EXT[type]}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  load().files[sha] = { sha, name: path.basename(name || `invoice.${EXT[type]}`), type, size: buf.length, path: file, at: state.files[sha]?.at || now() };
  persist();
  return state.files[sha];
}
export const getFile = (sha) => load().files[sha] || null;
export const readFile = (sha) => { const f = getFile(sha); return f ? fs.readFileSync(f.path) : null; };

// ---- approval queue
export function queueAdd(item) {
  const q = { id: id('bill'), created: now(), status: 'pending', ...item };
  load().queue.unshift(q);
  persist();
  return q;
}
export const queueAll = () => load().queue;
export const queueGet = (qid) => load().queue.find((q) => q.id === qid) || null;
export function queueUpdate(qid, patch) {
  const q = queueGet(qid);
  if (!q) throw new Error(`No approval item ${qid}`);
  Object.assign(q, patch, { updated: now() });
  persist();
  return q;
}

// ---- OAuth tokens for the accounting systems
export const tokens = (ledger) => load().tokens[ledger] || null;
export function setTokens(ledger, t) {
  if (t == null) delete load().tokens[ledger]; else load().tokens[ledger] = { ...(load().tokens[ledger] || {}), ...t };
  persist();
}

export function resetForTests() { state = null; }
