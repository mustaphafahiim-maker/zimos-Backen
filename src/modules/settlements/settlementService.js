'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { setFinancialState } = require('../orders/orderStateService');

const n = (v) => Number(v || 0);

const isSplit = (shipment) => Array.isArray(shipment.items);

/**
 * Delivered COD orders not yet on any settlement, with their delivering
 * carrier. An order sent as several parcels (item 375) is settled per
 * delivered parcel instead: a row for each one not yet on a settlement, due
 * the parcel's own COD amount (partial: true).
 */
async function listUnsettled(workspaceId, { carrierCode } = {}) {
  const orders = await db.Order.findAll({
    where: {
      workspaceId,
      paymentMethod: 'cod',
      fulfillmentState: { [Op.in]: ['fulfilled', 'partially_fulfilled'] },
      cancelledAt: null,
      financialState: { [Op.in]: ['pending', 'partially_paid'] },
      // NOT EXISTS, not a NOT IN over every settled id: that list only grows.
      [Op.and]: [
        db.Sequelize.literal(
          '(NOT EXISTS (SELECT 1 FROM cod_settlement_lines l WHERE l.order_id = "Order"."id" AND l.workspace_id = "Order"."workspace_id")' +
            " OR EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = \"Order\".\"id\" AND s.status = 'delivered' AND s.items IS NOT NULL" +
            ' AND NOT EXISTS (SELECT 1 FROM cod_settlement_lines l2 WHERE l2.shipment_id = s.id)))'
        ),
      ],
    },
    include: [{ model: db.Shipment, as: 'shipments', required: true, where: { status: 'delivered' } }],
    order: [['createdAt', 'ASC']],
  });

  const ids = orders.map((o) => o.id);
  const splitIds = orders.flatMap((o) => o.shipments.filter(isSplit).map((s) => s.id));
  const [orderLines, parcelLines] = await Promise.all([
    ids.length ? db.CodSettlementLine.findAll({ where: { workspaceId, orderId: ids }, attributes: ['orderId'], raw: true }) : [],
    splitIds.length ? db.CodSettlementLine.findAll({ where: { workspaceId, shipmentId: splitIds }, attributes: ['shipmentId'], raw: true }) : [],
  ]);
  const settledOrders = new Set(orderLines.map((l) => l.orderId));
  const settledParcels = new Set(parcelLines.map((l) => l.shipmentId));

  const row = (o, shipment, partial) => {
    const due = Math.max(0, n(o.totalAmount) - n(o.amountPaid));
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerName: (o.contactSnapshot || {}).fullName || null,
      carrierCode: shipment.carrierCode,
      shipmentId: shipment.id,
      waybillNumber: shipment.waybillNumber,
      deliveredAt: shipment.deliveredAt,
      currency: o.currency,
      totalAmount: n(o.totalAmount),
      amountPaid: n(o.amountPaid),
      partial,
      dueAmount: partial ? Math.min(n(shipment.codAmount), due) : due,
    };
  };
  const rows = orders
    .flatMap((o) => {
      const out = [];
      const whole = o.shipments.filter((s) => !isSplit(s));
      if (whole.length && !settledOrders.has(o.id)) {
        out.push(row(o, whole.sort((a, b) => new Date(b.deliveredAt || b.updatedAt) - new Date(a.deliveredAt || a.updatedAt))[0], false));
      }
      for (const s of o.shipments.filter(isSplit)) if (!settledParcels.has(s.id)) out.push(row(o, s, true));
      return out;
    })
    .filter((r) => !carrierCode || r.carrierCode === carrierCode);

  const byCarrier = {};
  for (const r of rows) {
    const c = (byCarrier[r.carrierCode] = byCarrier[r.carrierCode] || { carrierCode: r.carrierCode, orders: 0, dueAmount: 0 });
    c.orders += 1;
    c.dueAmount += r.dueAmount;
  }
  return { orders: rows, carriers: Object.values(byCarrier) };
}

function totals(lines) {
  const collected = lines.reduce((a, l) => a + n(l.collectedAmount), 0);
  const fees = lines.reduce((a, l) => a + n(l.feeAmount), 0);
  return { collectedAmount: collected, feesAmount: fees, netAmount: collected - fees };
}

async function detail(workspaceId, settlementId) {
  const s = await db.CodSettlement.findOne({
    where: { id: settlementId, workspaceId },
    include: [{ model: db.CodSettlementLine, as: 'lines', include: [{ model: db.Order, as: 'order', attributes: ['id', 'orderNumber', 'contactSnapshot', 'totalAmount', 'financialState'] }] }],
  });
  if (!s) throw new NotFoundError('Settlement');
  // What confirm actually added to each line (less than collected when the order was paid another way first).
  // Payments name their line (settlement:<id>:<lineId>, item 375); older ones only the settlement, keyed by order.
  const applied = {};
  if (s.status === 'confirmed') {
    const pays = await db.Payment.findAll({
      where: { workspaceId, providerReference: { [Op.or]: [`settlement:${s.id}`, { [Op.like]: `settlement:${s.id}:%` }] } },
      attributes: ['orderId', 'amount', 'providerReference'],
      raw: true,
    });
    for (const p of pays) {
      const key = p.providerReference.split(':')[2] || p.orderId;
      applied[key] = (applied[key] || 0) + n(p.amount);
    }
  }
  return {
    id: s.id,
    carrierCode: s.carrierCode,
    reference: s.reference,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    status: s.status,
    currency: s.currency,
    collectedAmount: n(s.collectedAmount),
    feesAmount: n(s.feesAmount),
    netAmount: n(s.netAmount),
    notes: s.notes,
    confirmedAt: s.confirmedAt,
    createdAt: s.createdAt,
    lines: s.lines.map((l) => ({
      id: l.id,
      orderId: l.orderId,
      shipmentId: l.shipmentId,
      orderNumber: l.order ? l.order.orderNumber : null,
      customerName: l.order ? (l.order.contactSnapshot || {}).fullName || null : null,
      orderTotal: l.order ? n(l.order.totalAmount) : null,
      financialState: l.order ? l.order.financialState : null,
      collectedAmount: n(l.collectedAmount),
      feeAmount: n(l.feeAmount),
      appliedAmount: s.status === 'confirmed' ? applied[l.id] || applied[l.orderId] || 0 : null,
    })),
  };
}

async function list(workspaceId, { status, limit = 50, before } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.CodSettlement.findAll({ where, order: [['createdAt', 'DESC']], limit });
  const counts = rows.length
    ? await db.CodSettlementLine.findAll({ where: { settlementId: rows.map((r) => r.id) }, attributes: ['settlementId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']], group: ['settlementId'], raw: true })
    : [];
  const byId = Object.fromEntries(counts.map((c) => [c.settlementId, Number(c.count)]));
  return {
    settlements: rows.map((s) => ({
      id: s.id,
      carrierCode: s.carrierCode,
      reference: s.reference,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      status: s.status,
      currency: s.currency,
      orders: byId[s.id] || 0,
      collectedAmount: n(s.collectedAmount),
      feesAmount: n(s.feesAmount),
      netAmount: n(s.netAmount),
      confirmedAt: s.confirmedAt,
      createdAt: s.createdAt,
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  };
}

/** Validates that every line is an unsettled delivered COD order and prices defaults. */
async function buildLines(workspaceId, lines, { excludeSettlementId } = {}) {
  const { orders: available } = await listUnsettled(workspaceId);
  if (excludeSettlementId) {
    const current = await db.CodSettlementLine.findAll({ where: { settlementId: excludeSettlementId }, include: [{ model: db.Order, as: 'order' }] });
    const parcelIds = current.map((l) => l.shipmentId).filter(Boolean);
    const parcels = new Map(
      (parcelIds.length ? await db.Shipment.findAll({ where: { id: parcelIds }, attributes: ['id', 'items', 'codAmount'] }) : []).map((s) => [s.id, s])
    );
    for (const l of current) {
      if (!l.order) continue;
      const parcel = parcels.get(l.shipmentId);
      const partial = Boolean(parcel && isSplit(parcel));
      if (available.some((u) => (partial ? u.shipmentId === l.shipmentId : !u.partial && u.orderId === l.orderId))) continue;
      const due = Math.max(0, n(l.order.totalAmount) - n(l.order.amountPaid));
      available.push({ orderId: l.orderId, shipmentId: l.shipmentId, partial, currency: l.order.currency, dueAmount: partial ? Math.min(n(parcel.codAmount), due) : due });
    }
  }
  const seen = new Set();
  return lines.map((line) => {
    const matches = available.filter((u) => u.orderId === line.orderId && (!line.shipmentId || u.shipmentId === line.shipmentId));
    if (!matches.length) throw new AppError('ORDER_NOT_SETTLEABLE', `Order ${line.orderId} is not a delivered, unsettled COD order`, 422);
    if (matches.length > 1) {
      throw new AppError('SHIPMENT_REQUIRED', `Order ${line.orderId} has several delivered parcels to settle: send the shipmentId of each`, 422, {
        shipmentIds: matches.map((u) => u.shipmentId),
      });
    }
    const o = matches[0];
    const key = o.partial ? `s:${o.shipmentId}` : `o:${o.orderId}`;
    if (seen.has(key)) throw new AppError('DUPLICATE_ORDER', 'An order appears twice in the settlement', 422);
    seen.add(key);
    const collected = line.collectedAmount !== undefined ? line.collectedAmount : o.dueAmount;
    if (collected > o.dueAmount) throw new AppError('COLLECTED_EXCEEDS_DUE', `Collected amount for order ${line.orderId} exceeds what is due`, 422);
    return { workspaceId, orderId: o.orderId, shipmentId: o.shipmentId || null, collectedAmount: collected, feeAmount: line.feeAmount || 0, currency: o.currency };
  });
}

async function create(workspaceId, body, req) {
  const built = await buildLines(workspaceId, body.lines);
  return db.sequelize.transaction(async (transaction) => {
    const t = totals(built);
    const s = await db.CodSettlement.create(
      {
        workspaceId,
        carrierCode: body.carrierCode,
        reference: body.reference || null,
        periodStart: body.periodStart || null,
        periodEnd: body.periodEnd || null,
        notes: body.notes || null,
        currency: built[0] ? built[0].currency : 'EGP',
        status: 'draft',
        createdByUserId: req.user.id,
        ...t,
      },
      { transaction }
    );
    await db.CodSettlementLine.bulkCreate(built.map(({ currency, ...l }) => ({ ...l, settlementId: s.id })), { transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'settlement.create', entityType: 'CodSettlement', entityId: s.id, after: { carrierCode: s.carrierCode, ...t, orders: built.length }, req, transaction });
    return s.id;
  });
}

async function update(workspaceId, settlementId, body, req) {
  const s = await db.CodSettlement.findOne({ where: { id: settlementId, workspaceId } });
  if (!s) throw new NotFoundError('Settlement');
  if (s.status !== 'draft') throw new AppError('SETTLEMENT_CONFIRMED', 'A confirmed settlement cannot be changed', 409);
  const built = body.lines ? await buildLines(workspaceId, body.lines, { excludeSettlementId: s.id }) : null;
  await db.sequelize.transaction(async (transaction) => {
    const patch = {};
    for (const k of ['carrierCode', 'reference', 'periodStart', 'periodEnd', 'notes']) if (body[k] !== undefined) patch[k] = body[k] || null;
    if (patch.carrierCode === null) delete patch.carrierCode;
    if (built) {
      await db.CodSettlementLine.destroy({ where: { settlementId: s.id }, transaction });
      await db.CodSettlementLine.bulkCreate(built.map(({ currency, ...l }) => ({ ...l, settlementId: s.id })), { transaction });
      Object.assign(patch, totals(built));
    }
    await s.update(patch, { transaction });
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'settlement.update', entityType: 'CodSettlement', entityId: s.id, req });
  return s.id;
}

async function remove(workspaceId, settlementId, req) {
  const s = await db.CodSettlement.findOne({ where: { id: settlementId, workspaceId } });
  if (!s) throw new NotFoundError('Settlement');
  if (s.status !== 'draft') throw new AppError('SETTLEMENT_CONFIRMED', 'A confirmed settlement cannot be deleted', 409);
  await s.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'settlement.delete', entityType: 'CodSettlement', entityId: s.id, req });
  return { deleted: true, id: s.id };
}

/** Records the cash as captured COD payments on each order and locks the settlement. */
async function confirm(workspaceId, settlementId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const s = await db.CodSettlement.findOne({ where: { id: settlementId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!s) throw new NotFoundError('Settlement');
    if (s.status !== 'draft') throw new AppError('SETTLEMENT_CONFIRMED', 'This settlement is already confirmed', 409);
    const lines = await db.CodSettlementLine.findAll({ where: { settlementId: s.id }, transaction });
    if (lines.length === 0) throw new AppError('SETTLEMENT_EMPTY', 'Add at least one order before confirming', 422);

    // The draft priced each line from what was due then. The order may have been
    // paid (cod-collected, a captured payment), cancelled or refunded since, so
    // each line adds only what the order still owes now and never pays it twice.
    const skipped = [];
    for (const line of lines) {
      const order = await db.Order.findOne({ where: { id: line.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!order || n(line.collectedAmount) <= 0) continue;
      const owing = !order.cancelledAt && ['pending', 'partially_paid'].includes(order.financialState);
      const applied = owing ? Math.min(n(line.collectedAmount), Math.max(0, n(order.totalAmount) - n(order.amountPaid))) : 0;
      if (applied < n(line.collectedAmount)) skipped.push({ orderId: order.id, orderNumber: order.orderNumber, collectedAmount: n(line.collectedAmount), appliedAmount: applied, financialState: order.financialState, cancelled: Boolean(order.cancelledAt) });
      if (applied <= 0) continue;
      await db.Payment.create(
        { workspaceId, orderId: order.id, providerCode: 'cod', status: 'captured', amount: applied, currency: order.currency, providerReference: `settlement:${s.id}:${line.id}` },
        { transaction }
      );
      const paid = n(order.amountPaid) + applied;
      await order.update({ amountPaid: paid }, { transaction });
      await setFinancialState(workspaceId, order.id, paid >= n(order.totalAmount) ? 'paid' : 'partially_paid', req, transaction);
    }

    await s.update({ status: 'confirmed', confirmedAt: new Date(), confirmedByUserId: req.user.id }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'settlement.confirm',
      entityType: 'CodSettlement',
      entityId: s.id,
      after: { netAmount: n(s.netAmount), orders: lines.length },
      metadata: skipped.length ? { notApplied: skipped } : null,
      req,
      transaction,
    });
    return s.id;
  });
}

/** Money overview: due from couriers vs received. */
async function summary(workspaceId) {
  const [{ orders }, confirmed, drafts] = await Promise.all([
    listUnsettled(workspaceId),
    db.CodSettlement.findAll({ where: { workspaceId, status: 'confirmed' }, attributes: ['collectedAmount', 'feesAmount', 'netAmount'], raw: true }),
    db.CodSettlement.count({ where: { workspaceId, status: 'draft' } }),
  ]);
  return {
    unsettledOrders: orders.length,
    dueFromCouriers: orders.reduce((a, o) => a + o.dueAmount, 0),
    received: confirmed.reduce((a, s) => a + n(s.netAmount), 0),
    courierFees: confirmed.reduce((a, s) => a + n(s.feesAmount), 0),
    draftSettlements: drafts,
  };
}

module.exports = { listUnsettled, list, detail, create, update, remove, confirm, summary };
