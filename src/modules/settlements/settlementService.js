'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { setFinancialState } = require('../orders/orderStateService');

const n = (v) => Number(v || 0);

/** Delivered COD orders not yet on any settlement, with their delivering carrier. */
async function listUnsettled(workspaceId, { carrierCode, courierId } = {}) {
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
          'NOT EXISTS (SELECT 1 FROM cod_settlement_lines l WHERE l.order_id = "Order"."id" AND l.workspace_id = "Order"."workspace_id")'
        ),
      ],
    },
    include: [
      {
        model: db.Shipment,
        as: 'shipments',
        required: true,
        where: { status: 'delivered' },
        include: [{ model: db.Courier, as: 'courier', attributes: ['id', 'name'] }],
      },
    ],
    order: [['createdAt', 'ASC']],
  });

  const rows = orders
    .map((o) => {
      const shipment = o.shipments.slice().sort((a, b) => new Date(b.deliveredAt || b.updatedAt) - new Date(a.deliveredAt || a.updatedAt))[0];
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        customerName: (o.contactSnapshot || {}).fullName || null,
        // The store's own courier (by id, shown by name), else the shipping company or name typed.
        carrierCode: shipment.courier ? shipment.courier.name : shipment.carrierCode,
        courierId: shipment.courierId || null,
        shipmentId: shipment.id,
        waybillNumber: shipment.waybillNumber,
        deliveredAt: shipment.deliveredAt,
        currency: o.currency,
        totalAmount: n(o.totalAmount),
        amountPaid: n(o.amountPaid),
        dueAmount: Math.max(0, n(o.totalAmount) - n(o.amountPaid)),
      };
    })
    .filter((r) => (!carrierCode || r.carrierCode === carrierCode) && (!courierId || r.courierId === courierId));

  // Grouped by courier id for the store's own couriers, by carrier code otherwise.
  const byCarrier = {};
  for (const r of rows) {
    const k = r.courierId ? `courier:${r.courierId}` : r.carrierCode;
    const c = (byCarrier[k] = byCarrier[k] || { carrierCode: r.carrierCode, courierId: r.courierId, orders: 0, dueAmount: 0 });
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
  // What confirm actually added to each order (less than collected when the order was paid another way first).
  const applied = {};
  if (s.status === 'confirmed') {
    const pays = await db.Payment.findAll({
      where: { workspaceId, providerReference: `settlement:${s.id}` },
      attributes: ['orderId', 'amount'],
      raw: true,
    });
    for (const p of pays) applied[p.orderId] = (applied[p.orderId] || 0) + n(p.amount);
  }
  return {
    id: s.id,
    carrierCode: s.carrierCode,
    courierId: s.courierId || null,
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
      orderNumber: l.order ? l.order.orderNumber : null,
      customerName: l.order ? (l.order.contactSnapshot || {}).fullName || null : null,
      orderTotal: l.order ? n(l.order.totalAmount) : null,
      financialState: l.order ? l.order.financialState : null,
      collectedAmount: n(l.collectedAmount),
      feeAmount: n(l.feeAmount),
      appliedAmount: s.status === 'confirmed' ? applied[l.orderId] || 0 : null,
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
      courierId: s.courierId || null,
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
  const { orders } = await listUnsettled(workspaceId);
  const available = new Map(orders.map((o) => [o.orderId, o]));
  if (excludeSettlementId) {
    const current = await db.CodSettlementLine.findAll({ where: { settlementId: excludeSettlementId }, include: [{ model: db.Order, as: 'order' }] });
    for (const l of current) {
      if (!available.has(l.orderId) && l.order) {
        available.set(l.orderId, { orderId: l.orderId, shipmentId: l.shipmentId, currency: l.order.currency, dueAmount: Math.max(0, n(l.order.totalAmount) - n(l.order.amountPaid)) });
      }
    }
  }
  const seen = new Set();
  return lines.map((line) => {
    const o = available.get(line.orderId);
    if (!o) throw new AppError('ORDER_NOT_SETTLEABLE', `Order ${line.orderId} is not a delivered, unsettled COD order`, 422);
    if (seen.has(line.orderId)) throw new AppError('DUPLICATE_ORDER', 'An order appears twice in the settlement', 422);
    seen.add(line.orderId);
    const collected = line.collectedAmount !== undefined ? line.collectedAmount : o.dueAmount;
    if (collected > o.dueAmount) throw new AppError('COLLECTED_EXCEEDS_DUE', `Collected amount for order ${line.orderId} exceeds what is due`, 422);
    return { workspaceId, orderId: o.orderId, shipmentId: o.shipmentId || null, collectedAmount: collected, feeAmount: line.feeAmount || 0, currency: o.currency };
  });
}

async function create(workspaceId, body, req) {
  const built = await buildLines(workspaceId, body.lines);
  // A settlement with one of the store's couriers carries their id, and their name as its carrier.
  const courier = body.courierId ? await require('../couriers/couriersService').findForStore(workspaceId, body.courierId) : null;
  return db.sequelize.transaction(async (transaction) => {
    const t = totals(built);
    const s = await db.CodSettlement.create(
      {
        workspaceId,
        carrierCode: body.carrierCode || (courier && courier.name),
        courierId: courier ? courier.id : null,
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
        { workspaceId, orderId: order.id, providerCode: 'cod', status: 'captured', amount: applied, currency: order.currency, providerReference: `settlement:${s.id}` },
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
