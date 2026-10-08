'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { clientIp } = require('../../core/middleware/clientIp');

/*
 * Back-in-stock alerts (spec-gaps item 194).
 *
 * - A shopper leaves an email, phone or (item 392) their browser's push
 *   subscription on a sold-out variant (available ≤ 0 and no overselling).
 *   One waiting alert per variant and address; at most 20 alerts an hour
 *   from one IP.
 * - When the variant's available stock goes from ≤ 0 to > 0 (a hook on the
 *   variant row, like product.low_stock), `variant.back_in_stock` is
 *   recorded; its consumer tells every waiting shopper once (email, or SMS)
 *   with a link to the product, and marks them notified.
 * - The merchant sees the waiting demand per product and variant.
 * Only a stock change is announced: no marketing consent is assumed, and the
 * address is used for this one message.
 */

const MAX_PER_IP_HOUR = 20;
const BATCH = 200;

const availableOf = (v) => (Number(v.stockOnHand) || 0) - (Number(v.reservedStock) || 0);

// ------------------------------------------------------------------ hook --

async function afterUpdate(variant, options) {
  try {
    const prev = variant._previousDataValues || {};
    if (!('stockOnHand' in prev) && !('reservedStock' in prev)) return;
    const before = (Number(prev.stockOnHand ?? variant.stockOnHand) || 0) - (Number(prev.reservedStock ?? variant.reservedStock) || 0);
    if (!(before <= 0 && availableOf(variant) > 0)) return;
    const transaction = options && options.transaction ? options.transaction : null;
    if (!(await db.StockAlert.count({ where: { variantId: variant.id, status: 'waiting' }, transaction }))) return;
    await require('../../core/outbox/outbox').record(transaction, 'variant.back_in_stock', { workspaceId: variant.workspaceId, productId: variant.productId, variantId: variant.id });
  } catch (err) {
    logger.error(`[stockAlerts] ${variant && variant.id}: ${err.message}`);
  }
}
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  db.ProductVariant.addHook('afterUpdate', 'zimosBackInStock', afterUpdate);
}
install();

// -------------------------------------------------------------- shopper --

async function subscribe(workspace, { variantId, email, phone, pushToken, locale }, ip) {
  const variant = await db.ProductVariant.findOne({ where: { id: variantId, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'status'] }] });
  if (!variant || !variant.product || variant.product.status !== 'active') throw new NotFoundError('Product');
  if (variant.allowOverselling || availableOf(variant) > 0) throw new AppError('IN_STOCK', 'This product is in stock — you can order it now', 409);
  let channel;
  let target;
  let push = null;
  if (pushToken) {
    // The browser itself (item 392): the store's app must be on and push available.
    channel = 'push';
    push = require('../notifications/push/stockAlertPush').prepare(workspace, pushToken);
    target = push.target;
  } else if (email) {
    channel = 'email';
    target = String(email).trim().toLowerCase();
  } else {
    channel = 'sms';
    target = normalizePhone(phone);
    if (!target) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422, [{ field: 'phone', message: 'Check the number' }]);
  }
  if (ip && (await db.StockAlert.count({ where: { requestIp: ip, createdAt: { [Op.gt]: new Date(Date.now() - 3600e3) } } })) >= MAX_PER_IP_HOUR) {
    throw new AppError('TOO_MANY_REQUESTS', 'Too many alerts asked — try again later', 429);
  }
  const existing = await db.StockAlert.findOne({ where: { variantId, target, status: 'waiting' } });
  if (!existing) {
    await db.StockAlert.create({ workspaceId: workspace.id, productId: variant.productId, variantId, channel, target, pushToken: push ? push.pushToken : null, locale: locale || null, requestIp: ip || null }).catch((err) => {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    });
  }
  return { subscribed: true, channel };
}

// ------------------------------------------------------------- consumer --

async function notify(event) {
  const p = event.payload || {};
  const workspaceId = event.workspaceId || p.workspaceId;
  if (!workspaceId || !p.variantId) return null;
  const variant = await db.ProductVariant.findOne({ where: { id: p.variantId, workspaceId }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'slug', 'status'] }] });
  // Sold out again before we got here, or gone: the shoppers keep waiting.
  if (!variant || !variant.product || variant.product.status !== 'active' || availableOf(variant) <= 0) return null;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'defaultLocale', 'settings'] });
  const origin = await require('../domains/primaryHost').storeOriginOf(workspace);
  const url = `${origin}/products/${encodeURIComponent(variant.product.slug || variant.product.id)}`;
  const options = variant.optionValues && Object.keys(variant.optionValues).length ? ` (${Object.values(variant.optionValues).join(' / ')})` : '';
  const name = `${variant.product.name}${options}`;
  const send = require('../notifications/notify');
  for (;;) {
    const batch = await db.StockAlert.findAll({ where: { variantId: variant.id, status: 'waiting' }, limit: BATCH, order: [['createdAt', 'ASC']] });
    if (!batch.length) break;
    for (const a of batch) {
      const lang = (a.locale || (workspace && workspace.defaultLocale)) === 'en' ? 'en' : 'ar';
      if (a.channel === 'push') {
        // Sent, failed or gone (404/410), the alert is done and its subscription dropped.
        await require('../notifications/push/stockAlertPush').send(a, { workspace, lang, productName: name, url });
        await a.update({ status: 'notified', notifiedAt: new Date(), pushToken: null });
        continue;
      }
      if (a.channel === 'email') {
        await send.email({ recipient: a.target, template: 'back_in_stock', data: { productName: name, url, storeName: workspace ? workspace.name : '', locale: lang }, workspaceId });
      } else {
        const body = lang === 'en' ? `${name} is back in stock at ${workspace.name}: ${url}` : `${name} رجع متاح في ${workspace.name}: ${url}`;
        await send.sms({ recipient: a.target, template: 'back_in_stock', data: { body }, workspaceId });
      }
      await a.update({ status: 'notified', notifiedAt: new Date() });
    }
  }
  return null;
}

// --------------------------------------------------------------- staff --

async function summary(workspaceId) {
  const rows = await db.sequelize.query(
    `SELECT a.product_id AS "productId", p.name AS "productName", a.variant_id AS "variantId", v.sku, v.option_values AS "optionValues",
            COUNT(*) FILTER (WHERE a.status = 'waiting')::int AS waiting,
            COUNT(*) FILTER (WHERE a.status = 'notified')::int AS notified,
            MAX(a.created_at) AS "lastRequestAt"
       FROM stock_alerts a JOIN products p ON p.id = a.product_id JOIN product_variants v ON v.id = a.variant_id
      WHERE a.workspace_id = :workspaceId
      GROUP BY a.product_id, p.name, a.variant_id, v.sku, v.option_values
      ORDER BY waiting DESC, "lastRequestAt" DESC
      LIMIT 200`,
    { replacements: { workspaceId }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return { variants: rows };
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/store/:workspaceId/stock-alerts.
const store = Router({ mergeParams: true });
store.post(
  '/',
  resolvePublicWorkspace,
  validate({
    params: Joi.object({ workspaceId: Joi.string().required() }),
    body: Joi.object({ variantId: Joi.string().uuid().required(), email: Joi.string().trim().email().max(255), phone: Joi.string().trim().min(6).max(32), pushToken: Joi.string().min(8).max(4000), locale: Joi.string().valid('ar', 'en', 'fr') }).xor('email', 'phone', 'pushToken'),
  }),
  asyncHandler(async (req, res) => res.status(201).json(await subscribe(req.publicWorkspace, req.body, clientIp(req))))
);

// Mounted at /api/v1/workspaces/:workspaceId/stock-alerts (products.view).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_VIEW));
staff.get('/', validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => res.json(await summary(req.tenant.workspaceId))));

module.exports = { store, staff, notify, subscribe, install };
