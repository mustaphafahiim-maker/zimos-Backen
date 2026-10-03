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
 */

const MAX_ROWS = 5000;
const HEADERS = {
  waybill: ['waybill', 'waybill number', 'awb', 'tracking number', 'tracking', 'tracking no', 'shipment', 'barcode', 'رقم البوليصة', 'رقم الشحنة', 'البوليصة'],
  amount: ['cod', 'cod amount', 'collected', 'collected amount', 'amount', 'cash collected', 'المبلغ', 'المبلغ المحصل', 'التحصيل'],
  fee: ['fee', 'fees', 'shipping fee', 'shipping fees', 'courier fee', 'charges', 'الرسوم', 'رسوم الشحن'],
};
const norm = (v) => String(v || '').trim().toLowerCase();

function parseStatement(csv) {
  const table = parseCsv(csv);
  if (table.length < 2) throw new ValidationError([{ field: 'csv', message: 'The file has no data rows' }], 'Nothing to match');
  if (table.length - 1 > MAX_ROWS) throw new ValidationError([{ field: 'csv', message: `At most ${MAX_ROWS} rows per statement` }], 'File too large');
  const header = table[0].map(norm);
  const col = {};
  for (const [field, names] of Object.entries(HEADERS)) col[field] = header.findIndex((h) => names.includes(h));
  const missing = ['waybill', 'amount'].filter((f) => col[f] < 0);
  if (missing.length) {
    throw new ValidationError(
      missing.map((f) => ({ field: f, message: `Column not found: ${HEADERS[f][0]}` })),
      'The statement is missing required columns'
    );
  }
  return table.slice(1).map((row, i) => ({
    line: i + 2,
    waybill: String(row[col.waybill] || '').trim(),
    amount: parseSpend(row[col.amount] || '', 2),
    fee: col.fee >= 0 && String(row[col.fee] || '').trim() !== '' ? parseSpend(row[col.fee], 2) : 0,
  }));
}

async function matchStatement(workspaceId, { csv, carrierCode }) {
  const rows = parseStatement(csv);
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
