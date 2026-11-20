import { get } from '../config.js';
import { demo } from './demo.js';
import { qbo } from './qbo.js';
import { xero } from './xero.js';
import { zoho } from './zoho.js';

const ALL = { demo, qbo, xero, zoho };
export const ledger = () => ALL[get('LEDGER')] || demo;

// Small cache so a chat that looks up vendors and accounts several times doesn't hit the API every time.
const cache = new Map();
export async function cached(key, fn, ms = 120000) {
  const k = `${get('LEDGER')}:${key}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(k, { at: Date.now(), value });
  return value;
}
export const clearCache = () => cache.clear();
