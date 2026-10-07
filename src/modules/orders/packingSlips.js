'use strict';

const Joi = require('joi');
const PDFDocument = require('pdfkit');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { registerFonts, drawText, hasArabic } = require('../../core/pdf/bidiText');

/*
 * Packing slips (spec-gaps item 244): one page per order to put in the
 * parcel — the store, the order number and date, who it goes to, every line
 * with its options and quantity, the gift message, and a short note. A gift
 * order whose shopper asked to hide the prices (item 214) gets no prices;
 * other orders show unit prices and the total. Emoji are dropped (the PDF
 * fonts have no glyphs). A5 or A4, as one PDF; beside the waybills,
 * invoices, manifest and pick list.
 */

const MAX = 200;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu;
const clean = (s) => String(s == null ? '' : s).replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').trim();
const money = (minor, currency) => `${(Number(minor) / 100).toFixed(2)} ${currency || ''}`.trim();

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  query: Joi.object({ as: Joi.string().valid('pdf', 'base64').default('pdf'), size: Joi.string().valid('A4', 'A5').default('A5') }),
  body: Joi.object({ orderIds: Joi.array().items(Joi.string().uuid()).min(1).max(MAX).unique().required(), note: Joi.string().trim().max(300).allow('', null) }),
};

function drawSlip(doc, { order, workspace, note, pieces }) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const hidePrices = Boolean(order.giftOptions && order.giftOptions.hidePrices);
  let y = doc.page.margins.top;

  y = drawText(doc, clean(workspace.name || 'Store'), { x: left, y, width, size: 16, bold: true, align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor('#666').text(`PACKING SLIP · ${order.orderNumber} · ${new Date(order.createdAt).toISOString().slice(0, 10)}`, left, y + 2, { lineBreak: false });
  doc.fillColor('#000');
  y += 16;
  doc.moveTo(left, y).lineTo(right, y).stroke('#ccc');
  y += 8;

  const contact = order.contactSnapshot || {};
  const addr = order.shippingAddressSnapshot || {};
  const pickup = order.shippingSnapshot && order.shippingSnapshot.pickup;
  const place = pickup ? `Pickup: ${pickup.name}` : [addr.addressLine, [addr.city, addr.province].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  const align = hasArabic(`${contact.fullName || ''} ${place}`) ? 'right' : 'left';
  y = drawText(doc, clean(contact.fullName) || '—', { x: left, y, width, size: 11, bold: true, align });
  if (place) y = drawText(doc, clean(place), { x: left, y, width, size: 9, align });
  y += 10;

  // Lines: the pieces to put in the parcel (orderUnits.js, item 294) — an offer of "3 pieces" is × 3, a
  // bundle's other variants are listed under it — with the line's amount (an offer is priced as a whole).
  const qtyW = 40;
  const priceW = hidePrices ? 0 : 80;
  const nameW = width - qtyW - priceW;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(9).text('Item', left, y, { width: nameW, lineBreak: false });
    doc.text('Qty', left + nameW, y, { width: qtyW, align: 'right', lineBreak: false });
    if (!hidePrices) doc.text('Amount', left + nameW + qtyW, y, { width: priceW, align: 'right', lineBreak: false });
    y += 13;
    doc.moveTo(left, y).lineTo(right, y).stroke('#eee');
    y += 4;
  };
  // A long order goes on to another page with the order number and the headers again (item 294).
  const room = (needed) => {
    if (y + needed <= bottomLimit()) return;
    doc.addPage({ size: [doc.page.width, doc.page.height], margin: doc.page.margins.top });
    y = doc.page.margins.top;
    doc.font('Helvetica').fontSize(9).fillColor('#666').text(`${order.orderNumber} (continued)`, left, y, { lineBreak: false });
    doc.fillColor('#000');
    y += 16;
    header();
  };
  header();
  for (const it of order.items) {
    const units = pieces.filter((u) => u.it === it);
    const own = units.filter((u) => u.own).reduce((n, u) => n + u.quantity, 0);
    const opts = Object.values(it.variantOptionsSnapshot || {}).join(' / ');
    const label = clean([it.productNameSnapshot, opts, it.offerNameSnapshot].filter(Boolean).join(' — ')) + (it.skuSnapshot ? `  (${it.skuSnapshot})` : '');
    room(28);
    const bottom = drawText(doc, label, { x: left, y, width: nameW - 6, size: 9, align: hasArabic(label) ? 'right' : 'left' });
    if (own) doc.font('Helvetica-Bold').fontSize(10).text(`× ${own}`, left + nameW, y, { width: qtyW, align: 'right', lineBreak: false });
    if (!hidePrices) doc.font('Helvetica').fontSize(9).text(money(it.lineTotalAmount, order.currency), left + nameW + qtyW, y, { width: priceW, align: 'right', lineBreak: false });
    y = Math.max(bottom, y + 12) + 4;
    for (const u of units.filter((x) => !x.own)) {
      const v = u.variant;
      const sub = clean(`+ ${[v && v.product ? v.product.name : it.productNameSnapshot, v ? Object.values(v.optionValues || {}).join(' / ') : null].filter(Boolean).join(' — ')}`) + (v && v.sku ? `  (${v.sku})` : '');
      room(24);
      const subBottom = drawText(doc, sub, { x: left + 12, y, width: nameW - 18, size: 8, align: hasArabic(sub) ? 'right' : 'left' });
      doc.font('Helvetica-Bold').fontSize(10).text(`× ${u.quantity}`, left + nameW, y, { width: qtyW, align: 'right', lineBreak: false });
      y = Math.max(subBottom, y + 11) + 3;
    }
  }
  room(60);
  doc.moveTo(left, y).lineTo(right, y).stroke('#eee');
  y += 6;
  if (!hidePrices) {
    doc.font('Helvetica-Bold').fontSize(10).text(`Total ${money(order.totalAmount, order.currency)}`, left, y, { width, align: 'right', lineBreak: false });
    y += 16;
  }

  const g = order.giftOptions;
  if (g && g.message) {
    room(80);
    y += 6;
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(g.wrapped ? 'GIFT MESSAGE (wrapped)' : 'GIFT MESSAGE', left, y, { lineBreak: false });
    doc.fillColor('#000');
    y += 11;
    const msg = clean(g.message);
    y = drawText(doc, msg, { x: left, y, width, size: 11, align: hasArabic(msg) ? 'right' : 'left' }) + 6;
  }
  if (note) {
    room(40);
    y += 8;
    const n = clean(note);
    drawText(doc, n, { x: left, y, width, size: 9, color: '#444', align: hasArabic(n) ? 'right' : 'left' });
    doc.fillColor('#000');
  }
}

async function packingSlipsPdf(workspaceId, { orderIds, note, size }) {
  // Cancelled orders get no slip (item 294), like the pick list; they come back in `skipped`.
  const found = await db.Order.findAll({ where: { workspaceId, id: orderIds }, include: [{ model: db.OrderItem, as: 'items' }], order: [[{ model: db.OrderItem, as: 'items' }, 'createdAt', 'ASC']] });
  const orders = found.filter((o) => !o.cancelledAt);
  const skipped = found.filter((o) => o.cancelledAt).map((o) => o.id);
  if (!orders.length) throw new AppError('NO_ORDERS_SELECTED', 'No orders to pack in this selection', 422, { skipped });
  const { physicalUnits } = require('./orderUnits');
  const pieces = await physicalUnits(orders.flatMap((o) => o.items));
  const others = [...new Set(pieces.filter((u) => !u.own && u.variantId).map((u) => u.variantId))];
  const variants = new Map(others.length ? (await db.ProductVariant.findAll({ where: { id: others }, paranoid: false, attributes: ['id', 'sku', 'optionValues', 'productId'], include: [{ model: db.Product, as: 'product', attributes: ['name'], paranoid: false }] })).map((v) => [v.id, v]) : []);
  for (const u of pieces) if (!u.own) u.variant = variants.get(u.variantId) || null;
  const byId = new Map(orders.map((o) => [o.id, o]));
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name'] });
  const doc = new PDFDocument({ size, margin: 32, autoFirstPage: false, info: { Title: `Packing slips (${orders.length})` } });
  registerFonts(doc);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  for (const id of orderIds) {
    const order = byId.get(id);
    if (!order) continue;
    doc.addPage({ size, margin: 32 });
    drawSlip(doc, { order, workspace, note, pieces: pieces.filter((u) => u.it.orderId === order.id) });
  }
  doc.end();
  return { pdf: await done, printed: orders.length, skipped };
}

const handler = asyncHandler(async (req, res) => {
  const { pdf, printed, skipped } = await packingSlipsPdf(req.tenant.workspaceId, { orderIds: req.body.orderIds, note: req.body.note, size: req.query.size });
  if (req.query.as === 'base64') return res.json({ filename: 'packing-slips.pdf', contentType: 'application/pdf', base64: pdf.toString('base64'), printed, skipped });
  res.setHeader('X-Skipped-Orders', String(skipped.length));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="packing-slips.pdf"');
  return res.send(pdf);
});

module.exports = { schema, handler, packingSlipsPdf };
