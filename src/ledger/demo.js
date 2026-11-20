// A built-in sample ledger so anyone can try the agent without connecting real books.
// Fictional company, vendors and bills. Dates are set relative to the day the demo is created so the aging looks real.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, get } from '../config.js';
import { round2 } from '../util.js';

const FILE = path.join(DATA_DIR, 'demo-ledger.json');
const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

function seed() {
  const vendors = [
    ['V1', 'Northwind Office Supplies', 'ar@northwind-supplies.example'],
    ['V2', 'Bow River Cleaning Co.', 'billing@bowriverclean.example'],
    ['V3', 'Peak IT Services', 'accounts@peakit.example'],
    ['V4', 'Prairie Power & Gas', 'billing@prairiepower.example'],
    ['V5', 'Foothills Plumbing Ltd.', 'office@foothillsplumbing.example'],
    ['V6', 'Stampede Legal LLP', 'invoices@stampedelegal.example'],
    ['V7', 'Chinook Elevator Maintenance', 'ar@chinookelevator.example'],
    ['V8', 'Parkside Landscaping', 'hello@parksidelandscaping.example'],
  ].map(([id, name, email]) => ({ id, name, email, currency: 'CAD' }));
  const accounts = [
    ['6000', 'Office Supplies'], ['6100', 'Cleaning & Janitorial'], ['6200', 'IT Services & Software'],
    ['6300', 'Utilities'], ['6400', 'Repairs & Maintenance'], ['6500', 'Professional Fees'],
    ['6600', 'Landscaping & Grounds'], ['6700', 'Meals & Entertainment'], ['6800', 'Elevator Maintenance'],
  ].map(([code, name]) => ({ id: code, code, name, type: 'Expense' }));
  const taxCodes = [
    { id: 'GST', name: 'GST 5%', rate: 5 }, { id: 'HST-ON', name: 'HST 13% (Ontario)', rate: 13 },
    { id: 'EXEMPT', name: 'Tax exempt', rate: 0 },
  ];
  const b = (n, vid, number, dateOff, terms, sub, paidPct = 0) => {
    const total = round2(sub * 1.05);
    return { id: `B${n}`, vendorId: vid, number, date: day(dateOff), dueDate: day(dateOff + terms), currency: 'CAD',
      subtotal: sub, tax: round2(total - sub), total, balance: round2(total * (1 - paidPct)) };
  };
  const bills = [
    b(1, 'V1', 'INV-10391', -75, 30, 1240.00), b(2, 'V2', 'BRC-2291', -20, 30, 3150.00),
    b(3, 'V3', 'PIT-5512', -48, 30, 2875.00), b(4, 'V4', 'PPG-88231', -12, 15, 4420.18),
    b(5, 'V5', 'FP-0457', -95, 30, 1890.00), b(6, 'V6', 'SL-2026-114', -33, 45, 7500.00),
    b(7, 'V7', 'CEM-7781', -5, 30, 2240.00), b(8, 'V8', 'PL-3302', -62, 30, 1675.50),
    b(9, 'V1', 'INV-10422', -16, 30, 486.20), b(10, 'V4', 'PPG-87120', -42, 15, 4105.77, 1),
    b(11, 'V2', 'BRC-2240', -50, 30, 3150.00, 1), b(12, 'V3', 'PIT-5560', -9, 30, 960.00),
    b(13, 'V7', 'CEM-7702', -36, 30, 2240.00), b(14, 'V5', 'FP-0491', -24, 30, 730.00, 0.5),
  ];
  const pos = [
    { id: 'PO1', number: 'PO-1007', vendorId: 'V3', date: day(-21), total: 4410.00, status: 'Open', description: 'Laptop refresh, 3 units incl. setup' },
    { id: 'PO2', number: 'PO-1011', vendorId: 'V8', date: day(-10), total: 2100.00, status: 'Open', description: 'Fall clean-up, all sites' },
  ];
  return { company: 'Maple Ridge Property Services (demo)', currency: 'CAD', vendors, accounts, taxCodes, bills, pos, next: 100 };
}

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = seed(); save(); }
  return db;
}
function save() { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }
export function resetDemo() { db = seed(); save(); return db; }

const vname = (id) => load().vendors.find((v) => v.id === id)?.name || id;
const withVendor = (x) => ({ ...x, vendorName: vname(x.vendorId) });

export const demo = {
  key: 'demo',
  label: 'Demo ledger',
  async info() { const d = load(); return { ledger: 'demo', connected: true, company: get('COMPANY_NAME') || d.company, currency: d.currency }; },
  async listVendors() { return load().vendors; },
  async createVendor({ name, email }) {
    const d = load(); const v = { id: `V${++d.next}`, name, email: email || '', currency: d.currency };
    d.vendors.push(v); save(); return v;
  },
  async listAccounts() { return load().accounts; },
  async listTaxCodes() { return load().taxCodes; },
  async listBills({ openOnly = false } = {}) {
    return load().bills.filter((x) => !openOnly || x.balance > 0.005).map((x) => ({ ...withVendor(x), status: x.balance > 0.005 ? 'Open' : 'Paid' }));
  },
  async findBillsByNumber(number) { return (await this.listBills()).filter((x) => x.number.toLowerCase() === String(number).toLowerCase()); },
  async listPurchaseOrders() { return load().pos.filter((p) => p.status === 'Open').map(withVendor); },
  async createBill(draft) {
    const d = load();
    let vendorId = draft.vendor.id;
    if (!vendorId) vendorId = (await this.createVendor({ name: draft.vendor.name, email: draft.vendor.email })).id;
    const bill = { id: `B${++d.next}`, vendorId, number: draft.number, date: draft.date, dueDate: draft.dueDate, currency: draft.currency || d.currency,
      subtotal: draft.subtotal, tax: draft.tax, total: draft.total, balance: draft.total, lines: draft.lines, poNumber: draft.poNumber || null };
    d.bills.push(bill);
    if (draft.poNumber) { const po = d.pos.find((p) => p.number === draft.poNumber); if (po) po.status = 'Billed'; }
    save();
    return { id: bill.id, url: null, total: bill.total, tax: bill.tax };
  },
};
