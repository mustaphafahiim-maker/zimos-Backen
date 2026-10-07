'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const providers = require('./providers');

/**
 * Dropshipping, order by order (SPEC §16.5: "automatic order forwarding",
 * "follow its status"), on top of the provider contract (providers/README.md):
 *
 *   - The order page's Supplier card: which connected suppliers supply its
 *     lines, what was forwarded to whom and where it stands there, and the
 *     buttons to forward it and to ask the supplier now.
 *       GET  /orders/:orderId/dropship              orders.view
 *       POST /orders/:orderId/dropship/:code/push   orders.manage
 *       POST /orders/:orderId/dropship/refresh      orders.manage
 *   - Forwarding by itself, per supplier (`autoForward`: off, when the order
 *     is placed, or once it is confirmed — config on the supplier's
 *     connection, set from the Apps page): an order holding that supplier's
 *     products is forwarded on order.created / order.confirmed. A test order,
 *     or one still waiting for its online payment, is not.
 *   - Following: every few minutes the open forwarded orders are asked about
 *     (`getOrderStatus`, an optional part of the contract). A new status is
 *     recorded (and shows on the order's timeline); with `applyStatus` on, the
 *     stage it means (`mapStatus`) is applied to the order when the order can
 *     make that move by hand — never backwards, never past a cancellation.
 *
 * Only the supplier's own lines are sent: a mixed order sends each supplier
 * what it supplies (`linesFor`).
 */

const FINAL = ['delivered', 'returned', 'cancelled'];
const FOLLOW_EVERY_MINUTES = 10;
const FOLLOW_FOR_DAYS = 60;
const AUTO_FORWARD = ['off', 'created', 'confirmed'];
const integrationKey = (code) => `dropship:${code}`;

const settingsOf = (row) => ({
  autoForward: AUTO_FORWARD.includes(row && row.config && row.config.autoForward) ? row.config.autoForward : 'off',
  applyStatus: Boolean(row && row.config && row.config.applyStatus),
  // The supplier's own shipping price and minimum order (supplierRules.js, item 263).
  useSupplierShipping: Boolean(row && row.config && row.config.useSupplierShipping),
  enforceMinimum: Boolean(row && row.config && row.config.enforceMinimum),
});

/** The suppliers this store can use now: connected, and their app installed where the app store lists one. */
async function connectedRows(workspaceId, transaction) {
  const codes = providers.list().available.map((p) => p.code);
  // On the caller's transaction when it has one (item 281): order creation asks this while holding its connection.
  const rows = await db.WorkspaceIntegration.findAll({ where: { workspaceId, provider: codes.map(integrationKey), status: 'connected' }, transaction });
  const { BY_KEY } = require('../apps/appCatalogue');
  const gate = require('../apps/appGate');
  const usable = [];
  for (const row of rows) {
    const key = `dropship_${row.provider.split(':')[1]}`;
    if (!BY_KEY.has(key) || (await gate.isEnabled(workspaceId, key, { transaction }))) usable.push(row);
  }
  return usable;
}

/** productId → the supplier codes that product came from (products.externalRefs). */
async function suppliersOfProducts(workspaceId, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.Product.findAll({ where: { workspaceId, id: ids }, attributes: ['id', 'externalRefs'], paranoid: false });
  return new Map(rows.map((p) => [p.id, (p.externalRefs || []).map((r) => r && r.platform).filter(Boolean)]));
}

/** The public-API order with only the lines `code` supplies (all of them when none is marked as its). */
async function linesFor(workspaceId, code, order) {
  const byProduct = await suppliersOfProducts(workspaceId, (order.items || []).map((i) => i.productId));
  const own = (order.items || []).filter((i) => (byProduct.get(i.productId) || []).includes(code));
  return own.length ? { ...order, items: own } : order;
}

const view = (ref) => {
  const provider = providers.get(ref.provider);
  return {
    provider: ref.provider,
    providerName: provider ? provider.name : ref.provider,
    externalOrderId: ref.externalOrderId,
    externalStatus: ref.externalStatus,
    // The stage the supplier's status means, as the provider maps it (null: no change).
    suggestedStage: provider && ref.externalStatus ? provider.mapStatus(ref.externalStatus) : null,
    forwardedBy: ref.forwardedBy,
    pushedAt: ref.pushedAt,
    checkedAt: ref.checkedAt,
    lastError: ref.lastError,
    followed: Boolean(provider && typeof provider.getOrderStatus === 'function') && !FINAL.includes(ref.externalStatus),
  };
};

/** GET — the order page's Supplier card. */
async function forOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items', attributes: ['productId'] }] });
  if (!order) throw new NotFoundError('Order');
  const [refs, rows, byProduct] = await Promise.all([
    db.DropshipOrderRef.findAll({ where: { workspaceId, orderId }, order: [['pushedAt', 'ASC']] }),
    connectedRows(workspaceId),
    suppliersOfProducts(workspaceId, order.items.map((i) => i.productId)),
  ]);
  const suppliers = rows
    .map((row) => providers.get(row.provider.split(':')[1]))
    .filter(Boolean)
    .map((provider) => ({
      code: provider.code,
      name: provider.name,
      isTest: Boolean(provider.isTest),
      // How many of the order's lines are this supplier's products.
      lines: order.items.filter((i) => (byProduct.get(i.productId) || []).includes(provider.code)).length,
    }))
    // A supplier with none of the order's products is still offered when nothing in the order is anyone's.
    .filter((s, _, all) => s.lines > 0 || all.every((x) => x.lines === 0));
  return { refs: refs.map(view), suppliers };
}

/** Asks the supplier where one forwarded order stands, and acts on a change. Never throws. */
async function checkRef(ref) {
  const provider = providers.get(ref.provider);
  if (!provider || typeof provider.getOrderStatus !== 'function') return { changed: false };
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: ref.workspaceId, provider: integrationKey(ref.provider) } });
  if (!row || row.status !== 'connected') {
    await ref.update({ checkedAt: new Date(), lastError: 'The supplier is not connected any more' });
    return { changed: false };
  }
  let answer;
  try {
    const credentials = JSON.parse(secretBox.open(row.secretsSealed));
    answer = await provider.getOrderStatus(credentials, ref.externalOrderId, { pushedAt: ref.pushedAt });
  } catch (err) {
    await ref.update({ checkedAt: new Date(), lastError: String(err.message || err).slice(0, 500) });
    return { changed: false };
  }
  const next = answer && answer.externalStatus ? String(answer.externalStatus).slice(0, 60) : null;
  const before = ref.externalStatus;
  await ref.update({ checkedAt: new Date(), lastError: null, ...(next ? { externalStatus: next } : {}) });
  if (!next || next === before) return { changed: false };

  const stage = provider.mapStatus(next);
  await recordAudit({
    workspaceId: ref.workspaceId,
    actorUserId: null,
    action: 'dropship.status_update',
    entityType: 'Order',
    entityId: ref.orderId,
    before: { provider: ref.provider, externalStatus: before },
    after: { provider: ref.provider, externalStatus: next, status: stage },
    metadata: { source: 'supplier' },
  });
  if (stage && settingsOf(row).applyStatus) await applyStage(ref, stage, next, provider);
  return { changed: true, externalStatus: next, stage };
}

/** The supplier's status as the order's stage, when the order may make that move by hand. */
async function applyStage(ref, stage, externalStatus, provider) {
  try {
    const statusHistory = require('../orders/orderStatusHistory');
    const { nextStages } = require('../orders/orderStateService');
    const from = await statusHistory.stageOf(ref.orderId);
    if (from === stage || !nextStages(from).includes(stage)) return;
    const req = await require('../automations/automationSteps').systemRequest(ref.workspaceId);
    await require('../orders/orderStageChange').changeStage(
      ref.workspaceId,
      ref.orderId,
      { status: stage, reason: `${provider.name}: ${externalStatus}` },
      req
    );
  } catch (err) {
    logger.warn('Dropship status not applied to the order', { orderId: ref.orderId, stage, message: err.message });
  }
}

/** POST refresh — ask now, for every supplier this order was forwarded to. */
async function refreshOrder(workspaceId, orderId) {
  const refs = await db.DropshipOrderRef.findAll({ where: { workspaceId, orderId } });
  for (const ref of refs) await checkRef(ref);
  return forOrder(workspaceId, orderId);
}

/** The repeatable job: the open forwarded orders not asked about for a while. */
async function follow({ batch = 100 } = {}) {
  const { Op } = db.Sequelize;
  const followed = providers
    .list()
    .available.filter((p) => typeof p.getOrderStatus === 'function')
    .map((p) => p.code);
  if (followed.length === 0) return 0;
  const refs = await db.DropshipOrderRef.findAll({
    where: {
      provider: followed,
      pushedAt: { [Op.gt]: new Date(Date.now() - FOLLOW_FOR_DAYS * 24 * 60 * 60 * 1000) },
      [Op.and]: [
        { [Op.or]: [{ externalStatus: null }, { externalStatus: { [Op.notIn]: FINAL } }] },
        { [Op.or]: [{ checkedAt: null }, { checkedAt: { [Op.lt]: new Date(Date.now() - FOLLOW_EVERY_MINUTES * 60 * 1000) } }] },
      ],
    },
    order: [[db.sequelize.literal('checked_at NULLS FIRST')]],
    limit: batch,
  });
  for (const ref of refs) await checkRef(ref);
  return refs.length;
}

/** The outbox consumer: forward a new / confirmed order to each supplier set to do it then. */
async function autoForward(event) {
  const payload = event.payload || {};
  const workspaceId = event.workspaceId || payload.workspaceId;
  const { orderId } = payload;
  if (!workspaceId || !orderId || payload.awaitingPayment || payload.isTest) return;
  const when = event.type === 'order.created' ? 'created' : event.type === 'order.confirmed' ? 'confirmed' : null;
  const rows = (await connectedRows(workspaceId)).filter((row) => settingsOf(row).autoForward === when);
  if (rows.length === 0) return;
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items', attributes: ['productId'] }] });
  if (!order || order.isTest || order.cancelledAt) return;
  const byProduct = await suppliersOfProducts(workspaceId, order.items.map((i) => i.productId));
  for (const row of rows) {
    const code = row.provider.split(':')[1];
    if (!order.items.some((i) => (byProduct.get(i.productId) || []).includes(code))) continue;
    if (await db.DropshipOrderRef.count({ where: { workspaceId, orderId, provider: code } })) continue;
    try {
      await require('./dropshipService').pushOrder(workspaceId, code, orderId, null, { via: 'auto' });
    } catch (err) {
      // The supplier refused it or could not be reached: the merchant sees it on the order and can send it by hand.
      logger.warn('Dropship auto-forward failed', { orderId, provider: code, message: err.message });
      await recordAudit({
        workspaceId,
        actorUserId: null,
        action: 'dropship.forward_failed',
        entityType: 'Order',
        entityId: orderId,
        after: { provider: code, error: String(err.message || err).slice(0, 300) },
        metadata: { source: 'supplier' },
      });
    }
  }
}

/** PATCH /dropship/providers/:code/settings (apps.manage). */
async function updateSettings(workspaceId, code, body, req) {
  if (!providers.get(code)) throw new NotFoundError('Dropship provider');
  const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: integrationKey(code) } });
  if (!row || row.status !== 'connected') throw new AppError('DROPSHIP_NOT_CONNECTED', 'Connect this supplier first', 409);
  const before = settingsOf(row);
  const config = { ...(row.config || {}) };
  if (body.autoForward !== undefined) config.autoForward = body.autoForward;
  if (body.applyStatus !== undefined) config.applyStatus = Boolean(body.applyStatus);
  // Each needs its adapter method (providers/README.md): a supplier that can't answer can't be switched on.
  const provider = providers.get(code);
  if (body.useSupplierShipping === true && typeof provider.shippingQuote !== 'function') throw new AppError('DROPSHIP_NOT_SUPPORTED', 'This supplier does not give shipping prices', 422);
  if (body.enforceMinimum === true && typeof provider.minimumOrder !== 'function') throw new AppError('DROPSHIP_NOT_SUPPORTED', 'This supplier has no minimum order to apply', 422);
  if (body.useSupplierShipping !== undefined) config.useSupplierShipping = Boolean(body.useSupplierShipping);
  if (body.enforceMinimum !== undefined) config.enforceMinimum = Boolean(body.enforceMinimum);
  await row.update({ config });
  const after = settingsOf(row);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'dropship.settings_update', entityType: 'WorkspaceIntegration', entityId: row.id, before, after, req });
  return { code, ...after };
}

// ------------------------------------------------------------------ routes --

// Inside the orders router (orderRoutes.js): authenticate and resolveTenant have run.
const router = Router({ mergeParams: true });
const params = (extra = {}) => Joi.object({ workspaceId: Joi.string().uuid().required(), orderId: Joi.string().uuid().required(), ...extra });

router.get(
  '/:orderId/dropship',
  validate({ params: params() }),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  asyncHandler(async (req, res) => res.json(await forOrder(req.tenant.workspaceId, req.params.orderId)))
);
router.post(
  '/:orderId/dropship/refresh',
  validate({ params: params() }),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json(await refreshOrder(req.tenant.workspaceId, req.params.orderId)))
);
router.post(
  '/:orderId/dropship/:code/push',
  validate({ params: params({ code: Joi.string().pattern(/^[a-z0-9_]{2,40}$/).required() }) }),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => {
    await require('./dropshipService').pushOrder(req.tenant.workspaceId, req.params.code, req.params.orderId, req);
    res.json(await forOrder(req.tenant.workspaceId, req.params.orderId));
  })
);

const settingsSchema = Joi.object({
  autoForward: Joi.string().valid(...AUTO_FORWARD).optional(),
  applyStatus: Joi.boolean().optional(),
  useSupplierShipping: Joi.boolean().optional(),
  enforceMinimum: Joi.boolean().optional(),
}).min(1);

module.exports = { AUTO_FORWARD, connectedRows, settingsOf, settingsSchema, linesFor, forOrder, checkRef, refreshOrder, follow, autoForward, updateSettings, router };
