// Settings come from (in order of priority) environment variables, then .env, then data/settings.json
// (what the user saves in the Settings screen). Nothing here is ever sent anywhere except the provider it belongs to.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.AP_DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const dotenv = readDotEnv(path.join(ROOT, '.env'));

// Keys a user may change from the Settings screen.
export const EDITABLE = [
  'LEDGER', 'AI_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_ENVIRONMENT', 'QBO_DEFAULT_TAX_CODE',
  'XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_BILL_STATUS',
  'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_ORGANIZATION_ID',
  'ALLOW_AI_POSTING', 'PO_TOLERANCE_PCT', 'COMPANY_NAME',
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_QUERY',
  'OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'OUTLOOK_TENANT', 'OUTLOOK_FOLDER',
  'WATCH_FOLDER', 'MOVE_PROCESSED', 'INTAKE_ENABLED', 'INTAKE_INTERVAL_MIN', 'INTAKE_LOOKBACK_DAYS', 'INTAKE_MAX_PER_RUN',
];
export const SECRET = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'QBO_CLIENT_SECRET', 'XERO_CLIENT_SECRET', 'GMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_SECRET', 'ZOHO_CLIENT_SECRET']);

const DEFAULTS = {
  PORT: '8787',
  HOST: '127.0.0.1',
  LEDGER: 'demo',                 // demo | qbo | xero | zoho
  AI_PROVIDER: 'anthropic',       // anthropic | openai
  ANTHROPIC_MODEL: 'claude-sonnet-5-5',
  OPENAI_MODEL: 'gpt-5.6-sol',
  QBO_ENVIRONMENT: 'sandbox',     // sandbox | production
  XERO_BILL_STATUS: 'AUTHORISED', // AUTHORISED | DRAFT  (status the bill gets in Xero once you approve it here)
  ALLOW_AI_POSTING: 'false',      // let a connected AI app post bills itself (off: people approve in the web app)
  PO_TOLERANCE_PCT: '2',
  GMAIL_QUERY: 'has:attachment (filename:pdf OR filename:png OR filename:jpg OR filename:jpeg) -in:sent -in:chats',
  OUTLOOK_TENANT: 'common',       // common | consumers | organizations | your tenant id
  OUTLOOK_FOLDER: 'inbox',
  MOVE_PROCESSED: 'false',        // move picked-up files into a "processed" subfolder of the watched folder
  INTAKE_ENABLED: 'true',         // check the connected sources on a timer
  INTAKE_INTERVAL_MIN: '5',
  INTAKE_LOOKBACK_DAYS: '3',      // on first connection, only look this far back
  INTAKE_MAX_PER_RUN: '20',       // cap on invoices processed per check (keeps AI costs predictable)
};

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

export function get(key) {
  if (process.env[key] != null && process.env[key] !== '') return process.env[key];
  const s = readSettings();
  if (s[key] != null && s[key] !== '') return String(s[key]);
  if (dotenv[key] != null && dotenv[key] !== '') return dotenv[key];
  return DEFAULTS[key] ?? '';
}
export const bool = (key) => /^(1|true|yes|on)$/i.test(get(key));
export const num = (key) => Number(get(key)) || 0;

export function save(patch) {
  const s = readSettings();
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) continue;
    if (v === null || v === '') delete s[k]; else s[k] = String(v).trim();
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// What the Settings screen sees: secrets only as "set / not set" plus the last 4 characters.
export function publicView() {
  const out = {};
  for (const k of EDITABLE) {
    const v = get(k);
    out[k] = SECRET.has(k) ? (v ? `•••• ${v.slice(-4)}` : '') : v;
  }
  out.lockedByEnv = EDITABLE.filter((k) => process.env[k]);
  return out;
}

// A random token that protects the AI-connector (MCP) address. Created once, kept in data/.
export function mcpToken() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  const f = path.join(DATA_DIR, 'mcp-token');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

export function publicUrl() {
  return (get('PUBLIC_URL') || `http://localhost:${get('PORT')}`).replace(/\/$/, '');
}
