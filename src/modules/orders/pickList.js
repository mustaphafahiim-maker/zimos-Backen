'use strict';

const Joi = require('joi');
const PDFDocument = require('pdfkit');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { registerFonts, drawText } = require('../../core/pdf/bidiText');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('./orderStage');

/*
 * Pick list (spec-gaps item 226): what to take off the shelves for a batch of
 * orders — the units summed per variant, grouped by the stock location each
 * order ships from (item 206; unassigned = the default location), with SKU,
 * image and the orders each line serves. For the orders picked in the list,
 * or every order ready to ship (up to 500). JSON, or a printable A4 PDF.
 */

const MAX = 500;

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  query: Joi.object({ as: Joi.string().valid('json', 'pdf', 'base64').default('json') }),
  body: Joi.object({
    orderIds: Joi.array().items(Joi.string().uuid()).min(1).max(MAX).unique(),
    readyToShip: Joi.boolean(),
    locationId: Joi.string().uuid().allow(null),
  }).xor('orderIds', 'readyToShip'),
};

async function build(workspaceId, { orderIds, readyToShip, locationId }) {
  let ids = orderIds;
  if (readyToShip) {
    const rows = await db.sequelize.query(
      `SELECT x.id FROM (SELECT o.id, o.created_at, ${STAGE_SQL} AS stage FROM ${ORDERS_WITH_STAGE_FROM}
          WHERE o.workspace_id = :ws AND o.is_test = false) x
        WHERE x.stage = 'ready_to_ship' ORDER BY x.created_at ASC LIMIT ${MAX}`,
      { replacements: { ws: workspaceId }, type: QueryTypes.SELECT }
    );
    ids = rows.map((r) => r.id);
  }
  const orders = ids.length ? await db.Order.findAll({ where: { workspaceId, id: ids, cancelledAt: null }, attributes: ['id', 'orderNumber', 'stockLocationId', 'createdAt'] }) : [];
  if (!orders.length) throw new AppError('NO_ORDERS_SELECTED', 'No orders to pick', 422);

  const locations = await db.StockLocation.findAll({ where: { workspaceId }, attributes: ['id', 'name', 'isDefault'] });
  const def = locations.find((l) => l.isDefault) || null;
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const where = (o) => o.stockLocationId || (def && def.id) || null;
  const picked = locationId ? orders.filter((o) => where(o) === locationId) : orders;
  if (!picked.length) throw new AppError('NO_ORDERS_SELECTED', 'None of these orders ships from that location', 422);

  const items = await db.OrderItem.findAll({ where: { orderId: picked.map((o) => o.id) }, attributes: ['orderId', 'productId', 'variantId', 'productNameSnapshot', 'variantOptionsSnapshot', 'skuSnapshot', 'quantity'] });
  const variants = await db.ProductVariant.findAll({ where: { id: [...new Set(items.map((i) => i.variantId).filter(Boolean))] }, attributes: ['id', 'imageUrl', 'sku'] });
  const vInfo = new Map(variants.map((v) => [v.id, v]));
  const orderOf = new Map(picked.map((o) => [o.id, o]));

  const groups = new Map();
  for (const it of items) {
    const o = orderOf.get(it.orderId);
    const loc = where(o);
    if (!groups.has(loc)) groups.set(loc, new Map());
    const lines = groups.get(loc);
    const key = it.variantId || `${it.productNameSnapshot}|${JSON.stringify(it.variantOptionsSnapshot || {})}`;
    if (!lines.has(key)) {
      const v = it.variantId && vInfo.get(it.variantId);
      lines.set(key, { variantId: it.variantId, productId: it.productId, name: it.productNameSnapshot, options: it.variantOptionsSnapshot || {}, sku: it.skuSnapshot || (v && v.sku) || null, imageUrl: (v && v.imageUrl) || null, quantity: 0, orders: [] });
    }
    const line = lines.get(key);
    line.quantity += it.quantity;
    line.orders.push({ orderId: o.id, orderNumber: o.orderNumber, quantity: it.quantity });
  }
  // Which lots to take each line from, first expiring first (stockLots/, item 230).
  for (const [loc, lines] of groups.entries()) for (const line of lines.values()) if (line.variantId) line.lots = await require('../stockLots').suggest(workspaceId, line.variantId, line.quantity, loc);
  const optText = (opts) => Object.values(opts || {}).join(' / ');
  return {
    orderCount: picked.length,
    unitCount: items.reduce((n, i) => n + i.quantity, 0),
    locations: [...groups.entries()].map(([id, lines]) => ({
      locationId: id,
      name: id ? locName.get(id) || null : null,
      lines: [...lines.values()].sort((a, b) => String(a.sku || '~').localeCompare(String(b.sku || '~')) || a.name.localeCompare(b.name) || optText(a.options).localeCompare(optText(b.options))),
    })),
  };
}

async function pdfOf(list) {
  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: 'Pick list' } });
  registerFonts(doc);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  doc.y = drawText(doc, 'PICK LIST / قائمة التجهيز', { x: left, y: doc.y, width, size: 16, bold: true, align: 'left' }) + 4;
  doc.font('Helvetica').fontSize(9).fillColor('#666').text(`${list.orderCount} orders · ${list.unitCount} units · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, left, doc.y);
  doc.fillColor('#000');
  doc.y += 8;
  for (const loc of list.locations) {
    if (doc.y > bottom - 60) doc.addPage();
    doc.y = drawText(doc, loc.name || 'Main stock', { x: left, y: doc.y + 6, width, size: 12, bold: true, align: 'left' }) + 4;
    for (const line of loc.lines) {
      if (doc.y > bottom - 40) doc.addPage();
      const top = doc.y;
      doc.rect(left, top + 2, 10, 10).stroke('#999');
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text(`${line.quantity} ×`, left + 16, top, { width: 44, lineBreak: false });
      const opts = Object.values(line.options || {}).join(' / ');
      let y = drawText(doc, [line.name, opts].filter(Boolean).join(' — '), { x: left + 64, y: top, width: width - 64 - 110, size: 10, align: 'left' });
      doc.font('Helvetica').fontSize(9).fillColor('#444').text(line.sku || '', left + width - 105, top, { width: 105, align: 'right', lineBreak: false });
      const orders = line.orders.map((o) => (o.quantity > 1 ? `${o.orderNumber} (${o.quantity})` : o.orderNumber)).join(', ');
      const lots = (line.lots || []).map((l) => `LOT ${l.lotCode}${l.expiresOn ? ` exp ${l.expiresOn}` : ''}: ${l.take}${l.expired ? ' (EXPIRED)' : ''}`).join('  ·  ');
      if (lots) { doc.font('Helvetica-Bold').fontSize(8).fillColor('#8a4b00').text(lots, left + 64, y, { width: width - 64 }); y = doc.y; }
      doc.font('Helvetica').fontSize(7).fillColor('#777').text(orders, left + 64, y, { width: width - 64 });
      y = doc.y;
      doc.fillColor('#000');
      doc.moveTo(left, y + 3).lineTo(left + width, y + 3).stroke('#eee');
      doc.y = y + 6;
    }
  }
  doc.end();
  return done;
}

const handler = asyncHandler(async (req, res) => {
  const list = await build(req.tenant.workspaceId, req.body);
  if (req.query.as === 'json') return res.json(list);
  const pdf = await pdfOf(list);
  if (req.query.as === 'base64') return res.json({ filename: 'pick-list.pdf', contentType: 'application/pdf', base64: pdf.toString('base64'), orderCount: list.orderCount });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="pick-list.pdf"');
  return res.send(pdf);
});

module.exports = { schema, build, handler };
