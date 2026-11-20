#!/usr/bin/env python3
"""Builds the fictional sample invoices in samples/ (needs reportlab; pdftoppm for the PNG one).
Each sample exercises a different control: clean bill, duplicate, PO match, new vendor + wrong tax, PO over-run (image)."""
import os, subprocess
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, black

OUT = os.path.join(os.path.dirname(__file__), '..', 'samples')
os.makedirs(OUT, exist_ok=True)
W, H = LETTER

def money(x): return f"{x:,.2f}"

def invoice(fname, v):
    c = canvas.Canvas(os.path.join(OUT, fname), pagesize=LETTER)
    c.setTitle(f"{v['vendor']} invoice {v['number']}")
    accent = HexColor(v['color'])
    c.setFillColor(accent); c.rect(0, H - 110, W, 110, fill=1, stroke=0)
    c.setFillColor(HexColor('#ffffff')); c.setFont('Helvetica-Bold', 22); c.drawString(48, H - 58, v['vendor'])
    c.setFont('Helvetica', 9.5)
    for i, line in enumerate(v['address']): c.drawString(48, H - 78 - i * 12, line)
    c.setFont('Helvetica-Bold', 26); c.drawRightString(W - 48, H - 62, v.get('title', 'INVOICE'))
    c.setFillColor(black)
    y = H - 150
    c.setFont('Helvetica-Bold', 9); c.drawString(48, y, 'BILL TO')
    c.setFont('Helvetica', 10)
    for i, line in enumerate(['Maple Ridge Property Services', 'Attn: Accounts Payable', '410 9 Ave SW, Suite 1200', 'Calgary, AB  T2P 1K4']):
        c.drawString(48, y - 15 - i * 13, line)
    meta = [('Invoice #', v['number']), ('Invoice date', v['date']), ('Terms', v['terms'])]
    if v.get('due'): meta.append(('Due date', v['due']))
    if v.get('po'): meta.append(('PO number', v['po']))
    if v.get('gst'): meta.append(('GST #', v['gst']))
    for i, (k, val) in enumerate(meta):
        c.setFont('Helvetica-Bold', 9.5); c.drawRightString(W - 170, y - i * 15, k)
        c.setFont('Helvetica', 10); c.drawString(W - 160, y - i * 15, val)
    y = H - 270
    c.setFillColor(HexColor('#f1f3f7')); c.rect(40, y - 6, W - 80, 22, fill=1, stroke=0); c.setFillColor(black)
    c.setFont('Helvetica-Bold', 9.5)
    c.drawString(48, y + 1, 'DESCRIPTION'); c.drawRightString(390, y + 1, 'QTY'); c.drawRightString(470, y + 1, 'UNIT PRICE'); c.drawRightString(W - 48, y + 1, 'AMOUNT')
    c.setFont('Helvetica', 10)
    sub = 0
    for desc, qty, unit in v['lines']:
        y -= 24; amt = round(qty * unit, 2); sub += amt
        c.drawString(48, y, desc); c.drawRightString(390, y, f"{qty:g}"); c.drawRightString(470, y, money(unit)); c.drawRightString(W - 48, y, money(amt))
        c.setStrokeColor(HexColor('#e3e6ec')); c.line(40, y - 8, W - 40, y - 8)
    sub = round(sub, 2)
    tax = v.get('tax_override', round(sub * v['rate'] / 100 + 1e-9, 2))
    total = round(sub + tax, 2)
    y -= 40
    for label, val, bold in [('Subtotal', sub, False), (v['tax_label'], tax, False), (f"TOTAL ({v['cur']})", total, True)]:
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 12 if bold else 10)
        c.drawRightString(470, y, label); c.drawRightString(W - 48, y, money(val)); y -= 20
    c.setFont('Helvetica', 9); c.setFillColor(HexColor('#555555'))
    for i, line in enumerate(v['footer']): c.drawString(48, 90 - i * 12, line)
    c.setFont('Helvetica-Oblique', 8); c.drawString(48, 40, 'Sample invoice for testing Open AP Agent. Fictional company.')
    c.save()
    print(fname, 'subtotal', sub, 'tax', tax, 'total', total)

invoice('northwind-INV-10458.pdf', dict(
    vendor='Northwind Office Supplies', color='#1f4e8c', number='INV-10458', date='2026-11-14', terms='Net 30', due='2026-12-14', gst='81234 5678 RT0001',
    address=['2210 Barlow Trail NE', 'Calgary, AB  T1Y 1A1', 'ar@northwind-supplies.example'],
    lines=[('Printer paper, letter, case of 10 reams', 12, 54.50), ('Toner cartridge HP 58X, black', 4, 189.00), ('Desk organizer, mesh, 5 compartments', 10, 18.75)],
    rate=5, tax_label='GST 5%', cur='CAD', footer=['Thank you for your business.', 'Pay by EFT to Northwind Office Supplies, ref. invoice number.']))

invoice('bowriver-BRC-2291.pdf', dict(
    vendor='Bow River Cleaning Co.', color='#2c7a5b', number='BRC-2291', date='2026-11-02', terms='Net 30', gst='77812 3311 RT0001',
    address=['55 Riverfront Ave SE', 'Calgary, AB  T2G 4Z1', 'billing@bowriverclean.example'],
    lines=[('Janitorial services, October, 3 buildings', 1, 2700.00), ('Window cleaning, exterior, Building B', 1, 450.00)],
    rate=5, tax_label='GST (5%)', cur='CAD', footer=['Questions? billing@bowriverclean.example', 'Late payments subject to 2% monthly interest.']))

invoice('peakit-PIT-5601.pdf', dict(
    vendor='Peak IT Services', color='#5b2c8a', number='PIT-5601', date='2026-11-16', terms='Net 30', due='2026-12-16', po='PO-1007', gst='70123 9876 RT0001',
    address=['800 6 Ave SW, Floor 3', 'Calgary, AB  T2P 3G3', 'accounts@peakit.example'],
    lines=[('Laptop, 14in, 32GB RAM, 1TB SSD', 3, 1350.00), ('Setup, imaging and data transfer', 3, 125.00)],
    rate=5, tax_label='GST 5%', cur='CAD', footer=['Hardware warranty: 3 years on-site.', 'Remit to Peak IT Services Inc.']))

invoice('chinook-catering-CC-0912.pdf', dict(
    vendor='Chinook Catering Co.', color='#b4472b', number='CC-0912', date='2026-11-17', terms='Due on receipt', due='2026-11-17',
    address=['1402 17 Ave SW', 'Calgary, AB  T2T 0C3', 'orders@chinookcatering.example'],
    lines=[('Board meeting lunch, 18 guests', 18, 32.00), ('Delivery and setup', 1, 45.00)],
    rate=5, tax_override=37.26, tax_label='GST 5%', cur='CAD', footer=['Thank you! E-transfer accepted: orders@chinookcatering.example']))

invoice('_parkside.pdf', dict(
    vendor='Parkside Landscaping', color='#4d7c0f', number='PL-3349', date='2026-11-15', terms='Net 15', due='2026-11-30', po='PO-1011',
    address=['31 Crowfoot Way NW', 'Calgary, AB  T3G 2L4', 'hello@parksidelandscaping.example'],
    lines=[('Fall clean-up, all sites (per PO-1011)', 1, 2100.00), ('Additional leaf removal, Building C', 1, 260.00)],
    rate=5, tax_label='GST 5%', cur='CAD', footer=['Thanks for choosing Parkside.']))
subprocess.run(['pdftoppm', '-png', '-r', '110', '-singlefile', os.path.join(OUT, '_parkside.pdf'), os.path.join(OUT, 'parkside-PL-3349')], check=True)
os.remove(os.path.join(OUT, '_parkside.pdf'))
print('done')
