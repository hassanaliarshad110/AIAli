export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const money = (n, cur = '') => `${cur ? cur + ' ' : ''}${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
export const today = () => new Date().toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
// "INV 00123" and "inv-123" are the same invoice number for duplicate checks.
export const normNumber = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^([a-z]*)0+(\d)/, '$1$2');
export const normName = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(inc|ltd|llp|llc|co|corp|limited|company|the)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

export async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text.slice(0, 500) }; }
}
