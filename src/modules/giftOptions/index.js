'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { effectiveVariantPrice } = require('../catalog/productPage');
const { requireStoreFeature, storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * Gift wrap and gift message at checkout.
 * settings.gift_options = { enabled, wrapVariantId | null, messageMaxLength }
 *
 * - The wrap is a product the merchant makes and prices (a "Gift wrap"
 *   variant): asking for it adds one line of it to the order, so its price,
 *   tax, stock and reports work like any line. No wrap variant = message only.
 * - The message (and "hide the prices") is kept on the order
 *   (orders.gift_options), shown on the order page and printed on the waybill.
 * - Checkout body: `gift: { wrap?: boolean, message?: string, hidePrices?: boolean }`.
 * - Off (STORE_FEATURES without gift_options): a gift in the checkout body is
 *   ignored, as before, and the storefront is offered none.
 */

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.gift_options) || {};
  return { enabled: Boolean(s.enabled), wrapVariantId: s.wrapVariantId || null, messageMaxLength: Number.isInteger(s.messageMaxLength) ? s.messageMaxLength : 300 };
}

/** Checkout, before the order: the gift choice checked; returns { line, options } or null. */
async function prepare(workspace, gift) {
  if (!storeFeatureOn('gift_options') || !gift || (!gift.wrap && !gift.message && !gift.hidePrices)) return null;
  const s = settingsOf(workspace);
  if (!s.enabled) throw new ValidationError([{ field: 'gift', message: 'This store does not offer gift options' }], 'Invalid body');
  const message = gift.message ? String(gift.message).trim() : null;
  if (message && message.length > s.messageMaxLength) throw new ValidationError([{ field: 'gift.message', message: `At most ${s.messageMaxLength} characters` }], 'Invalid body');
  let line = null;
  if (gift.wrap) {
    if (!s.wrapVariantId) throw new ValidationError([{ field: 'gift.wrap', message: 'This store does not offer gift wrap' }], 'Invalid body');
    const v = await db.ProductVariant.findOne({ where: { id: s.wrapVariantId, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'status'] }] });
    if (!v || !v.product || v.product.status !== 'active' || v.status !== 'active') throw new ValidationError([{ field: 'gift.wrap', message: 'Gift wrap is not available right now' }], 'Invalid body');
    line = { variantId: v.id, quantity: 1 };
  }
  return { line, options: { wrapped: Boolean(line), message, hidePrices: Boolean(gift.hidePrices) } };
}

/** After the order exists: keep the choice on it. */
async function recordOnOrder(order, prepared) {
  if (!prepared) return;
  await db.Order.update({ giftOptions: prepared.options }, { where: { id: order.id }, hooks: false });
  order.giftOptions = prepared.options;
}

/** The waybill's lines (waybill/waybillService.js, before the custom-field answers): the message first. */
function waybillLines(order) {
  const g = order && order.giftOptions;
  if (!g) return [];
  return [g.wrapped ? 'GIFT - WRAP / هدية - تغليف' : 'GIFT / هدية', ...(g.message ? [`"${g.message}"`] : [])];
}

/** What the storefront shows: null when off. */
async function publicView(workspace) {
  if (!storeFeatureOn('gift_options')) return null;
  const s = settingsOf(workspace);
  if (!s.enabled) return null;
  let wrap = null;
  if (s.wrapVariantId) {
    const v = await db.ProductVariant.findOne({ where: { id: s.wrapVariantId, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'status', 'pageSettings'] }] });
    if (v && v.product && v.product.status === 'active' && v.status === 'active') wrap = { variantId: v.id, name: v.product.name, priceAmount: String(effectiveVariantPrice(v, v.product).priceAmount), currency: v.currency, imageUrl: v.imageUrl || null };
  }
  return { messageMaxLength: s.messageMaxLength, wrap };
}

// Mounted at /api/v1/workspaces/:workspaceId/gift-options.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('gift_options'));
staff.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: ws }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] })))));
staff.put(
  '/',
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({ params: ws, body: Joi.object({ enabled: Joi.boolean().required(), wrapVariantId: Joi.string().uuid().allow(null), messageMaxLength: Joi.number().integer().min(20).max(500) }) }),
  asyncHandler(async (req, res) => {
    if (req.body.wrapVariantId && !(await db.ProductVariant.count({ where: { id: req.body.wrapVariantId, workspaceId: req.tenant.workspaceId } }))) {
      throw new ValidationError([{ field: 'wrapVariantId', message: 'Pick a product of this store' }]);
    }
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const next = { ...settingsOf(workspace), ...req.body };
    await workspace.update({ settings: { ...(workspace.settings || {}), gift_options: next } });
    require('../storefront/storefrontCache').invalidate(workspace.id);
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'gift_options.update', entityType: 'Workspace', entityId: workspace.id, after: next, req });
    res.json(settingsOf(workspace));
  })
);

module.exports = { staff, prepare, recordOnOrder, waybillLines, publicView, settingsOf };
