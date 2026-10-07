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
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Scan to pack (spec-gaps item 249). The packer scans each item (barcode, or
 * types the SKU); the page sends every scan so far and the server answers
 * what each order line expects against what was scanned — nothing is kept
 * between calls, so a reload or a second device just sends the list again.
 *   lines     expected / scanned / done per line
 *   unknown   codes that match no line of the order (wrong item)
 *   over      lines scanned more often than ordered
 *   complete  every line scanned exactly
 * Confirm marks the order packed (tag `packed`, audited with the scans); a
 * scan list that is not complete needs `force` with a note (e.g. an item
 * without a barcode). Codes match a variant's barcode or SKU, trimmed and
 * case-insensitive; lines without a variant can't be scanned and are listed
 * as `manual`.
 */

const norm = (s) => String(s || '').trim().toLowerCase();

async function check(workspaceId, orderId, scans) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'orderNumber', 'cancelledAt', 'tags'] });
  if (!order) throw new NotFoundError('Order');
  if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'The order is cancelled', 409);
  const items = await db.OrderItem.findAll({ where: { orderId: order.id }, attributes: ['id', 'variantId', 'offerId', 'productNameSnapshot', 'variantOptionsSnapshot', 'skuSnapshot', 'quantity'], order: [['createdAt', 'ASC'], ['id', 'ASC']] });

  // The physical pieces each line holds (orderUnits.js, items 271, 289).
  const units = await require('./orderUnits').physicalUnits(items);
  const variants = new Map((await db.ProductVariant.findAll({ where: { id: [...new Set(units.map((u) => u.variantId).filter(Boolean))] }, paranoid: false, attributes: ['id', 'sku', 'barcode', 'optionValues'] })).map((v) => [v.id, v]));

  // One entry per variant (a variant on two lines, or in a bundle and on its own, is one pile to fill).
  const byVariant = new Map();
  const manual = [];
  for (const u of units) {
    const { it } = u;
    if (!u.variantId) { manual.push({ name: it.productNameSnapshot, quantity: u.quantity }); continue; }
    const v = variants.get(u.variantId);
    if (!byVariant.has(u.variantId)) {
      byVariant.set(u.variantId, {
        variantId: u.variantId, name: it.productNameSnapshot, options: (u.own ? it.variantOptionsSnapshot : v && v.optionValues) || {},
        sku: (v && v.sku) || (u.own ? it.skuSnapshot : null) || null, barcode: (v && v.barcode) || null,
        codes: [v && v.sku, v && v.barcode, u.own ? it.skuSnapshot : null].filter(Boolean).map(norm), expected: 0, scanned: 0,
      });
    }
    byVariant.get(u.variantId).expected += u.quantity;
  }
  const lines = [...byVariant.values()];
  const unknown = [];
  for (const raw of scans) {
    const code = norm(raw);
    if (!code) continue;
    const line = lines.find((l) => l.codes.includes(code));
    if (line) line.scanned += 1;
    else unknown.push(String(raw).trim());
  }
  const out = lines.map(({ codes, ...l }) => ({ ...l, done: l.scanned === l.expected, missing: Math.max(0, l.expected - l.scanned), over: Math.max(0, l.scanned - l.expected) }));
  return {
    order: { id: order.id, orderNumber: order.orderNumber, packed: (order.tags || []).includes('packed') },
    lines: out,
    manual,
    unknown,
    over: out.filter((l) => l.over > 0).map((l) => ({ variantId: l.variantId, name: l.name, over: l.over })),
    complete: out.length > 0 && out.every((l) => l.done) && unknown.length === 0,
    progress: { scanned: out.reduce((n, l) => n + Math.min(l.scanned, l.expected), 0), expected: out.reduce((n, l) => n + l.expected, 0) },
  };
}

// Mounted at /api/v1/workspaces/:workspaceId/orders/:orderId/pack (orders.manage).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ORDERS_MANAGE));
const params = Joi.object({ workspaceId: Joi.string().uuid().required(), orderId: Joi.string().uuid().required() });
const scansSchema = Joi.array().items(Joi.string().trim().max(120).allow('')).max(2000).required();

router.post('/check', validate({ params, body: Joi.object({ scans: scansSchema }) }), asyncHandler(async (req, res) => {
  res.json(await check(req.tenant.workspaceId, req.params.orderId, req.body.scans));
}));

router.post('/confirm', validate({ params, body: Joi.object({ scans: scansSchema, force: Joi.boolean().default(false), note: Joi.string().trim().max(300).allow('', null) }) }), asyncHandler(async (req, res) => {
  const result = await check(req.tenant.workspaceId, req.params.orderId, req.body.scans);
  if (!result.complete && !req.body.force) throw new AppError('PACK_NOT_COMPLETE', 'Some items are missing, extra or wrong', 409, { lines: result.lines, unknown: result.unknown });
  if (!result.complete && !req.body.note) throw new ValidationError([{ field: 'note', message: 'Say why the order is packed without every scan' }]);
  await require('./orderMetaService').updateMeta(req.tenant.workspaceId, req.params.orderId, { addTags: ['packed'] }, req);
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'order.packed', entityType: 'Order', entityId: req.params.orderId, after: { complete: result.complete, forced: !result.complete, note: req.body.note || null, scanned: result.progress, unknown: result.unknown }, req });
  res.json({ packed: true, complete: result.complete });
}));

module.exports = { router, check };
