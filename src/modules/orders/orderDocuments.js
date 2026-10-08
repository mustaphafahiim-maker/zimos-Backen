'use strict';

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { registerFonts, drawText, hasArabic } = require('../../core/pdf/bidiText');
const { computeWaybillModel, waybillShipmentIds } = require('../waybill/waybillService');
const { SHIPMENT_IN_MOTION } = require('./shipmentLifecycle');

/**
 * Printed paper for many orders at once (SPEC §12.4):
 *
 *   waybills   one PDF of labels — four to an A4 page, or one per 10×15 cm
 *              thermal label — for the orders picked in the list;
 *   manifest   the handover sheet the courier signs: every parcel handed
 *              over, its waybill number and the cash to collect.
 *
 * The label is a compact form of the single-order waybill and reads the same
 * model (waybill/waybillService.computeWaybillModel), so the barcode and the
 * amount to collect are the ones the single waybill prints.
 */

const MAX_DOCUMENT_ORDERS = 200;
const money = (minor, currency) => `${(Number(minor) / 100).toFixed(2)} ${currency || ''}`.trim();
const mm = (n) => (n * 72) / 25.4;

const FORMATS = {
  // A4 portrait, 2 × 2.
  a4x4: { size: 'A4', perPage: 4, cell: (doc, i) => {
    const margin = 18;
    const w = (doc.page.width - margin * 3) / 2;
    const h = (doc.page.height - margin * 3) / 2;
    return { x: margin + (i % 2) * (w + margin), y: margin + Math.floor(i / 2) * (h + margin), w, h };
  } },
  // 10 × 15 cm thermal label, one per page.
  '10x15': { size: [mm(100), mm(150)], perPage: 1, cell: (doc) => ({ x: 10, y: 10, w: doc.page.width - 20, h: doc.page.height - 20 }) },
};

function collect(doc) {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  return new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
}

async function barcodePng(text) {
  return bwipjs.toBuffer({ bcid: 'code128', text: String(text), scale: 2, height: 11, includetext: false, backgroundcolor: 'FFFFFF' });
}

function addressLines(address) {
  if (!address) return [];
  return [address.addressLine, [address.city, address.province].filter(Boolean).join(', '), address.notes].filter(Boolean);
}

/** One label inside the box { x, y, w, h }. */
async function drawLabel(doc, model, box) {
  const { order, shipment, carrier, trackingValue, isCod, storeName, shipTo, address } = model;
  const pad = 10;
  const x = box.x + pad;
  const w = box.w - pad * 2;
  let y = box.y + pad;

  doc.lineWidth(0.8).rect(box.x, box.y, box.w, box.h).stroke('#999');

  y = drawText(doc, storeName, { x, y, width: w, size: 12, bold: true, align: 'left' });
  doc.font('Helvetica').fontSize(8).fillColor('#666').text(`Order ${order.orderNumber}`, x, y, { lineBreak: false });
  doc.fillColor('#000');
  y += 12;

  doc.image(await barcodePng(trackingValue), x, y, { fit: [w, 40] });
  y += 42;
  doc.font('Helvetica-Bold').fontSize(10).text(String(trackingValue), x, y, { width: w, lineBreak: false });
  y += 14;
  if (carrier && carrier.name) {
    y = drawText(doc, carrier.name, { x, y, width: w, size: 9, align: 'left' });
  }
  y += 4;
  doc.moveTo(x, y).lineTo(x + w, y).stroke('#ccc');
  y += 6;

  const lines = addressLines(address);
  const align = hasArabic([shipTo.fullName, ...lines].join(' ')) ? 'right' : 'left';
  y = drawText(doc, shipTo.fullName || '—', { x, y, width: w, size: 12, bold: true, align });
  if (shipTo.phone) y = drawText(doc, shipTo.phone, { x, y, width: w, size: 11, align, direction: 'ltr' });
  if (lines.length) y = drawText(doc, lines.join('\n'), { x, y, width: w, size: 10, align });

  // The amount sits at the foot of the label whatever the address length.
  const footY = box.y + box.h - pad - 34;
  // The custom-field answers, as many as fit above it (waybill/customData.js).
  if (model.customData && model.customData.length) {
    require('../waybill/customData').drawCustomData(doc, model.customData, { x, y: y + 4, width: w, size: 8, maxY: footY - 4 });
  }
  if (isCod) {
    doc.rect(x, footY, w, 34).fillAndStroke('#fff4e5', '#e08a00');
    doc.fillColor('#8a4b00').font('Helvetica-Bold').fontSize(8).text('COLLECT (CASH)', x + 6, footY + 5, { lineBreak: false });
    doc.fontSize(14).text(money(model.amountToCollect, order.currency), x + 6, footY + 16, { lineBreak: false });
  } else {
    doc.rect(x, footY, w, 34).stroke('#1a7f37');
    doc.fillColor('#1a7f37').font('Helvetica-Bold').fontSize(11).text('PREPAID — DO NOT COLLECT', x + 6, footY + 12, { lineBreak: false });
  }
  doc.fillColor('#000');
  return shipment;
}

async function assertOrders(workspaceId, orderIds) {
  const ids = [...new Set(orderIds)];
  if (ids.length > MAX_DOCUMENT_ORDERS) {
    throw new AppError('TOO_MANY_ORDERS', `At most ${MAX_DOCUMENT_ORDERS} orders can be printed at once`, 422);
  }
  const found = await db.Order.findAll({ where: { workspaceId, id: ids }, attributes: ['id'] });
  const known = new Set(found.map((o) => o.id));
  const kept = ids.filter((id) => known.has(id));
  if (kept.length === 0) throw new AppError('NO_ORDERS_SELECTED', 'No orders match this selection', 422);
  return kept;
}

/** The labels of the given orders, in the order given, as one PDF; an order sent as several parcels gets one per live parcel (item 375). */
async function waybillsPdf(workspaceId, { orderIds, format = 'a4x4' }) {
  const layout = FORMATS[format] || FORMATS.a4x4;
  const ids = await assertOrders(workspaceId, orderIds);

  const doc = new PDFDocument({ size: layout.size, margin: 0, autoFirstPage: false, info: { Title: 'Waybills' } });
  registerFonts(doc);
  const done = collect(doc);
  let index = 0;
  for (const id of ids) {
    for (const shipmentId of await waybillShipmentIds(workspaceId, id)) {
      const slot = index % layout.perPage;
      if (slot === 0) doc.addPage({ size: layout.size, margin: 0 });
      await drawLabel(doc, await computeWaybillModel(workspaceId, id, { shipmentId }), layout.cell(doc, slot));
      index += 1;
    }
  }
  doc.end();
  return done;
}

/**
 * The courier handover sheet. The parcels are the given orders' live
 * shipments, or — with no orders named — every shipment created on `date`
 * (UTC day, default today), optionally for one courier.
 */
async function manifestPdf(workspaceId, { orderIds, date, carrier } = {}) {
  const where = { workspaceId, status: { [Op.notIn]: ['cancelled', 'returned'] } };
  let day = null;
  if (orderIds && orderIds.length) {
    where.orderId = await assertOrders(workspaceId, orderIds);
  } else {
    day = date ? new Date(date) : new Date();
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    where.createdAt = { [Op.gte]: start, [Op.lt]: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
  }
  if (carrier) where.carrierCode = { [Op.iLike]: carrier };

  const shipments = await db.Shipment.findAll({
    where,
    include: [{ model: db.Order, as: 'order' }],
    order: [['carrierCode', 'ASC'], ['createdAt', 'ASC']],
    limit: 1000,
  });
  // One row per order: its newest live shipment. An order sent as several
  // parcels (item 375) has a row per parcel, each with its own COD amount;
  // for named orders only the parcels not yet handed over (not delivered or
  // already on the road), so the cash total is what this courier takes now.
  const byOrder = new Map();
  for (const s of shipments) {
    if (!Array.isArray(s.items)) byOrder.set(s.orderId, s);
    else if (!day && SHIPMENT_IN_MOTION.includes(s.status)) continue;
    else byOrder.set(s.id, s);
  }
  const rows = [...byOrder.values()];
  if (rows.length === 0) throw new AppError('NO_SHIPMENTS', 'There are no shipments to hand over for this selection', 422);

  const workspace = await db.Workspace.findByPk(workspaceId);
  const doc = new PDFDocument({ size: 'A4', margin: 32, info: { Title: 'Courier manifest' } });
  registerFonts(doc);
  const done = collect(doc);
  const left = doc.page.margins.left;
  const width = doc.page.width - left * 2;
  const currency = rows[0].order.currency;

  const cols = [
    { title: '#', w: 22 },
    { title: 'Order', w: 118 },
    { title: 'Waybill', w: 92 },
    { title: 'Customer', w: 110 },
    { title: 'Phone', w: 78 },
    { title: 'Governorate', w: 62 },
    { title: 'Collect', w: width - 482 },
  ];

  const header = () => {
    let y = drawText(doc, (workspace && workspace.name) || 'Store', { x: left, y: doc.page.margins.top, width, size: 15, bold: true, align: 'left' });
    const couriers = [...new Set(rows.map((r) => r.carrierCode))].join(', ');
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    y = drawText(doc, `Courier handover manifest — ${day ? day.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)} — ${couriers}`, {
      x: left, y: y + 2, width, size: 9, align: 'left',
    });
    doc.fillColor('#000');
    y += 8;
    let x = left;
    doc.font('Helvetica-Bold').fontSize(8);
    for (const c of cols) {
      doc.text(c.title, x + 2, y, { width: c.w - 4, lineBreak: false });
      x += c.w;
    }
    y += 12;
    doc.moveTo(left, y).lineTo(left + width, y).stroke('#000');
    return y + 4;
  };

  let y = header();
  let total = 0;
  for (const [index, s] of rows.entries()) {
    if (y > doc.page.height - 110) {
      doc.addPage();
      y = header();
    }
    const o = s.order;
    const contact = o.contactSnapshot || {};
    const collectAmount = require('../shipping/partialShipments').codAmountForShipment(o, s);
    total += collectAmount;
    const cells = [
      String(index + 1),
      o.orderNumber,
      s.waybillNumber || s.trackingCode,
      contact.fullName || '—',
      contact.phone || '',
      (o.shippingAddressSnapshot && o.shippingAddressSnapshot.province) || '',
      o.paymentMethod === 'cod' ? money(collectAmount, '') : 'prepaid',
    ];
    let x = left;
    let bottom = y;
    for (const [i, c] of cols.entries()) {
      const b = drawText(doc, String(cells[i]), { x: x + 2, y, width: c.w - 4, size: 8, align: 'left', direction: i === 4 ? 'ltr' : undefined });
      bottom = Math.max(bottom, b);
      x += c.w;
    }
    y = bottom + 3;
    doc.moveTo(left, y).lineTo(left + width, y).stroke('#ddd');
    y += 3;
  }

  y += 8;
  doc.font('Helvetica-Bold').fontSize(11).text(`Parcels: ${rows.length}`, left, y, { lineBreak: false });
  doc.text(`Cash to collect: ${money(total, currency)}`, left + 180, y, { lineBreak: false });
  y += 40;
  doc.font('Helvetica').fontSize(9);
  doc.text('Handed over by: ______________________', left, y, { lineBreak: false });
  doc.text('Received by (courier): ______________________', left + width / 2, y, { lineBreak: false });

  doc.end();
  return done;
}

module.exports = { MAX_DOCUMENT_ORDERS, FORMATS: Object.keys(FORMATS), waybillsPdf, manifestPdf };
