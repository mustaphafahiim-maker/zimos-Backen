'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { parseCsv, parseSpend } = require('../profit/adSpendService');
const settlements = require('./settlementService');

/**
 * Courier statement import (SPEC §15.5): the merchant uploads the statement
 * the courier sends with a remittance; every row is matched to a shipment by
 * waybill (or tracking code), and the differences are spelled out:
 *
 *   ok                 delivered, unsettled COD order, amount equals what is due
 *   amount_mismatch    matched, but the courier's amount differs from what is due
 *   already_settled    the order is already on another settlement
 *   not_settleable     matched, but not a delivered unpaid COD order (returned, prepaid, cancelled…)
 *   not_found          no shipment of this store has that waybill
 *   duplicate          the waybill appears twice in the statement
 *
 * plus the delivered orders of that courier the statement does not mention —
 * money the courier is still holding.
 *
 * The statement comes as the courier sends it: an Excel file (.xlsx, its first
 * sheet) or CSV, as `fileBase64` (+ `fileName`), or as CSV text (`csv`).
 * Couriers put a title, the account and the period above the table, so the
 * header is the first of the top rows that names a waybill and an amount
 * column; line numbers in the report are the file's own.
 */

const MAX_ROWS = 5000;
const HEADERS = {
  waybill: [
    'waybill', 'waybill number', 'waybill no', 'awb', 'awb no', 'awb number', 'tracking number', 'tracking', 'tracking no',
    'tracking code', 'shipment', 'shipment number', 'shipment no', 'barcode', 'order tracking number',
    'رقم البوليصة', 'رقم الشحنة', 'البوليصة', 'رقم التتبع', 'كود الشحنة',
  ],
  amount: [
    'cod', 'cod amount', 'cod value', 'cod collected', 'collected cod', 'collected', 'collected amount', 'amount',
    'cash collected', 'cash on delivery', 'المبلغ', 'المبلغ المحصل', 'التحصيل', 'قيمة التحصيل', 'المحصل',
  ],
  fee: [
    'fee', 'fees', 'shipping fee', 'shipping fees', 'courier fee', 'delivery fee', 'delivery fees', 'service fee', 'service fees',
    'shipping cost', 'charges', 'الرسوم', 'رسوم الشحن', 'مصاريف الشحن', 'تكلفة الشحن',
  ],
};
const norm = (v) => String(v || '').trim().toLowerCase();
// "AWB No.", " Tracking  Number: " and "awb no" are one header.
const headerNorm = (v) => norm(v).replace(/[.:#*]+/g, ' ').replace(/[_\s]+/g, ' ').trim();
// The totals line couriers add under the table.
const TOTALS = /^(total|totals|grand total|sum|الإجمالي|الاجمالي|إجمالي|اجمالي|المجموع)\b/i;
const HEADER_SCAN = 20;
const MAX_FILE_BYTES = 1024 * 1024;

/** The statement's table: rows of strings, from an uploaded file (xlsx / csv) or CSV text. */
function tableOf({ csv, fileBase64, fileName }) {
  if (!fileBase64) return parseCsv(csv || '');
  const buffer = Buffer.from(String(fileBase64), 'base64');
  if (buffer.length === 0) throw new ValidationError([{ field: 'fileBase64', message: 'The file is empty' }], 'Nothing to match');
  if (buffer.length > MAX_FILE_BYTES) throw new ValidationError([{ field: 'fileBase64', message: 'The file is larger than 1 MB' }], 'File too large');
  const sheets = require('../catalog/importExport/sheetReader');
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  try {
    return (isZip || /\.xlsx$/i.test(fileName || '') ? sheets.parseXlsx(buffer) : sheets.parseCsv(buffer)).map((row) => row.map((cell) => String(cell ?? '')));
  } catch (err) {
    if (err instanceof sheets.SheetError) throw new ValidationError([{ field: 'fileBase64', message: err.message }], 'The file cannot be read');
    throw new ValidationError([{ field: 'fileBase64', message: 'Not an Excel (.xlsx) or CSV file' }], 'The file cannot be read');
  }
}

function parseStatement(input) {
  const table = tableOf(typeof input === 'string' ? { csv: input } : input);
  if (table.length < 2) throw new ValidationError([{ field: 'csv', message: 'The file has no data rows' }], 'Nothing to match');
  if (table.length - 1 > MAX_ROWS) throw new ValidationError([{ field: 'csv', message: `At most ${MAX_ROWS} rows per statement` }], 'File too large');
  const columnsOf = (cells) => {
    const header = cells.map(headerNorm);
    const col = {};
    for (const [field, names] of Object.entries(HEADERS)) col[field] = header.findIndex((h) => names.includes(h));
    return col;
  };
  // The header: the first top row naming both a waybill and an amount column (titles above it are skipped).
  let headerAt = table.slice(0, HEADER_SCAN).findIndex((cells) => {
    const c = columnsOf(cells);
    return c.waybill >= 0 && c.amount >= 0;
  });
  if (headerAt < 0) headerAt = 0;
  const col = columnsOf(table[headerAt]);
  const missing = ['waybill', 'amount'].filter((f) => col[f] < 0);
  if (missing.length) {
    throw new ValidationError(
      missing.map((f) => ({ field: f, message: `Column not found: ${HEADERS[f][0]}` })),
      'The statement is missing required columns'
    );
  }
  return table
    .slice(headerAt + 1)
    .map((row, i) => ({ row, line: headerAt + i + 2 }))
    // Blank lines and the totals line (no waybill, a "Total" label) are not shipments; any
    // other line without a waybill stays, reported as invalid.
    .filter(({ row }) => {
      if (!row.some((cell) => String(cell || '').trim() !== '')) return false;
      const waybill = String(row[col.waybill] || '').trim();
      if (TOTALS.test(waybill)) return false;
      return waybill !== '' || !row.some((cell) => TOTALS.test(String(cell || '').trim()));
    })
    .map(({ row, line }) => ({
    line,
    waybill: String(row[col.waybill] || '').trim(),
    amount: parseSpend(row[col.amount] || '', 2),
    fee: col.fee >= 0 && String(row[col.fee] || '').trim() !== '' ? parseSpend(row[col.fee], 2) : 0,
  }));
}

async function matchStatement(workspaceId, { csv, fileBase64, fileName, carrierCode }) {
  const rows = parseStatement({ csv, fileBase64, fileName });
  const keys = [...new Set(rows.map((r) => r.waybill).filter(Boolean))];
  const lowered = keys.map(norm);
  const [shipments, { orders: unsettled }] = await Promise.all([
    keys.length
      ? db.Shipment.findAll({
          where: {
            workspaceId,
            [Op.or]: [
              db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('waybill_number')), { [Op.in]: lowered }),
              db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('tracking_code')), { [Op.in]: lowered }),
            ],
          },
          attributes: ['id', 'orderId', 'carrierCode', 'waybillNumber', 'trackingCode', 'status'],
        })
      : [],
    settlements.listUnsettled(workspaceId, { carrierCode }),
  ]);
  const byKey = new Map();
  for (const s of shipments) {
    if (s.waybillNumber) byKey.set(norm(s.waybillNumber), s);
    if (s.trackingCode && !byKey.has(norm(s.trackingCode))) byKey.set(norm(s.trackingCode), s);
  }
  const orderIds = [...new Set(shipments.map((s) => s.orderId))];
  const [orders, settledLines] = await Promise.all([
    orderIds.length
      ? db.Order.findAll({ where: { workspaceId, id: orderIds }, attributes: ['id', 'orderNumber', 'contactSnapshot', 'totalAmount', 'amountPaid'] })
      : [],
    orderIds.length ? db.CodSettlementLine.findAll({ where: { workspaceId, orderId: orderIds }, attributes: ['orderId'], raw: true }) : [],
  ]);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const settled = new Set(settledLines.map((l) => l.orderId));
  const due = new Map(unsettled.map((o) => [o.orderId, o]));

  const seenOrders = new Set();
  const lines = rows.map((r) => {
    const base = { line: r.line, waybill: r.waybill, statementAmount: r.amount, feeAmount: r.fee || 0 };
    if (!r.waybill || r.amount === null) return { ...base, status: 'invalid' };
    const shipment = byKey.get(norm(r.waybill));
    if (!shipment) return { ...base, status: 'not_found' };
    const order = orderById.get(shipment.orderId);
    const info = {
      ...base,
      orderId: shipment.orderId,
      orderNumber: order ? order.orderNumber : null,
      customerName: order ? (order.contactSnapshot || {}).fullName || null : null,
      shipmentStatus: shipment.status,
    };
    if (seenOrders.has(shipment.orderId)) return { ...info, status: 'duplicate' };
    seenOrders.add(shipment.orderId);
    if (settled.has(shipment.orderId)) return { ...info, status: 'already_settled' };
    const open = due.get(shipment.orderId);
    if (!open) return { ...info, status: 'not_settleable' };
    return {
      ...info,
      dueAmount: open.dueAmount,
      differenceAmount: r.amount - open.dueAmount,
      status: r.amount === open.dueAmount ? 'ok' : 'amount_mismatch',
    };
  });

  const inStatement = new Set(lines.filter((l) => l.orderId).map((l) => l.orderId));
  const missing = unsettled
    .filter((o) => !inStatement.has(o.orderId))
    .map((o) => ({
      orderId: o.orderId, orderNumber: o.orderNumber, customerName: o.customerName, waybill: o.waybillNumber,
      carrierCode: o.carrierCode, deliveredAt: o.deliveredAt, dueAmount: o.dueAmount,
    }));

  const count = (status) => lines.filter((l) => l.status === status).length;
  const settleable = lines.filter((l) => l.status === 'ok' || l.status === 'amount_mismatch');
  return {
    carrierCode: carrierCode || null,
    currency: (unsettled[0] && unsettled[0].currency) || 'EGP',
    summary: {
      rows: lines.length,
      ok: count('ok'),
      amountMismatch: count('amount_mismatch'),
      alreadySettled: count('already_settled'),
      notSettleable: count('not_settleable'),
      notFound: count('not_found'),
      duplicate: count('duplicate'),
      invalid: count('invalid'),
      statementAmount: lines.reduce((a, l) => a + (l.statementAmount || 0), 0),
      matchedDueAmount: settleable.reduce((a, l) => a + l.dueAmount, 0),
      // What the statement is short (negative) or over (positive) against what is due.
      differenceAmount: settleable.reduce((a, l) => a + l.differenceAmount, 0),
      missingOrders: missing.length,
      missingAmount: missing.reduce((a, o) => a + o.dueAmount, 0),
    },
    lines,
    missingFromStatement: missing.slice(0, 500),
  };
}

/**
 * Creates a draft settlement from the statement's settleable rows. A row that
 * claims more than the order is due is capped at the due amount (an order
 * cannot be over-collected); the difference stays in the saved report.
 */
async function importStatement(workspaceId, body, req) {
  if (!body.carrierCode) throw new ValidationError([{ field: 'carrierCode', message: 'Choose the courier' }], 'Courier is required');
  const report = await matchStatement(workspaceId, body);
  const lines = report.lines
    .filter((l) => l.status === 'ok' || l.status === 'amount_mismatch')
    .map((l) => ({
      orderId: l.orderId,
      collectedAmount: Math.min(l.statementAmount, l.dueAmount),
      feeAmount: Math.min(l.feeAmount || 0, Math.min(l.statementAmount, l.dueAmount)),
    }));
  if (lines.length === 0) {
    throw new ValidationError([{ field: 'csv', message: 'No row of the statement matches a delivered, unsettled order' }], 'Nothing to settle');
  }
  const id = await settlements.create(
    workspaceId,
    { carrierCode: body.carrierCode, reference: body.reference, periodStart: body.periodStart, periodEnd: body.periodEnd, notes: body.notes, lines },
    req
  );
  const saved = {
    importedAt: new Date().toISOString(),
    summary: report.summary,
    discrepancies: report.lines.filter((l) => l.status !== 'ok').slice(0, 500),
    missingFromStatement: report.missingFromStatement.slice(0, 200),
  };
  await db.CodSettlement.update({ statementReport: saved }, { where: { id, workspaceId } });
  await recordAudit({
    workspaceId, actorUserId: req.user.id, action: 'settlement.statement_import', entityType: 'CodSettlement', entityId: id,
    after: report.summary, req,
  });
  return { settlementId: id, report };
}

async function statementReport(workspaceId, settlementId) {
  const s = await db.CodSettlement.findOne({ where: { id: settlementId, workspaceId }, attributes: ['id', 'statementReport'] });
  return s ? s.statementReport : null;
}

/** Money couriers are still holding: delivered, unsettled COD orders by courier and by age. */
async function held(workspaceId) {
  const { orders } = await settlements.listUnsettled(workspaceId);
  const now = Date.now();
  const carriers = new Map();
  for (const o of orders) {
    const c = carriers.get(o.carrierCode) || {
      carrierCode: o.carrierCode, orders: 0, dueAmount: 0, oldestDeliveredAt: null,
      buckets: { upTo7: 0, upTo14: 0, over14: 0 },
    };
    const days = o.deliveredAt ? (now - new Date(o.deliveredAt).getTime()) / 86400000 : 0;
    c.orders += 1;
    c.dueAmount += o.dueAmount;
    c.buckets[days <= 7 ? 'upTo7' : days <= 14 ? 'upTo14' : 'over14'] += o.dueAmount;
    if (o.deliveredAt && (!c.oldestDeliveredAt || new Date(o.deliveredAt) < new Date(c.oldestDeliveredAt))) c.oldestDeliveredAt = o.deliveredAt;
    carriers.set(o.carrierCode, c);
  }
  const list = Array.from(carriers.values()).sort((a, b) => b.dueAmount - a.dueAmount);
  return {
    currency: (orders[0] && orders[0].currency) || 'EGP',
    totalAmount: list.reduce((a, c) => a + c.dueAmount, 0),
    totalOrders: orders.length,
    carriers: list,
  };
}

module.exports = { matchStatement, importStatement, statementReport, held };
