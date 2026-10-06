'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');

/*
 * Licence code pool alerts (spec-gaps item 213 — the pool, drawing on payment
 * and late filling already exist in digitalService). After a paid order draws
 * codes, the team (inventory.view) is told, once a day per product:
 *   - orders are waiting for codes (the pool ran out), or
 *   - the pool is at or below settings.license_codes_low_at (default 5).
 */

const DEFAULT_LOW_AT = 5;
const lowAtOf = (workspace) => {
  const v = workspace && workspace.settings && workspace.settings.license_codes_low_at;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_LOW_AT;
};
const today = () => new Date().toISOString().slice(0, 10);

async function checkPools(workspaceId, productIds) {
  try {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
    const lowAt = lowAtOf(workspace);
    const notify = require('../notifications/merchantNotificationService');
    for (const productId of [...new Set(productIds)]) {
      const product = await db.Product.findByPk(productId, { attributes: ['id', 'name'] });
      if (!product) continue;
      const available = await db.LicenseCode.count({ where: { productId, assignedAt: null } });
      const waiting = Number(await db.DigitalGrant.sum('codesMissing', { where: { workspaceId, productId, revokedAt: null } })) || 0;
      if (waiting > 0) {
        await notify.create(workspaceId, {
          type: 'stock.low',
          title: `طلبات مستنية أكواد: ${product.name}`,
          body: `${waiting} كود ناقص — أضف أكواد وهتتبعت للطلبات على طول.`,
          link: `/catalog/${productId}?tab=digital`,
          data: { productId, label: product.name, available, waitingCodes: waiting },
          dedupeKey: `codes.waiting:${productId}:${today()}`,
          localized: { en: { title: `Orders waiting for codes: ${product.name}`, body: `${waiting} codes missing — add codes and they go out at once.` }, ar: { title: `طلبات مستنية أكواد: ${product.name}`, body: `${waiting} كود ناقص — أضف أكواد وهتتبعت للطلبات على طول.` } },
        });
      } else if (available <= lowAt) {
        await notify.create(workspaceId, {
          type: 'stock.low',
          title: `الأكواد قربت تخلص: ${product.name}`,
          body: `فاضل ${available} كود.`,
          link: `/catalog/${productId}?tab=digital`,
          data: { productId, label: product.name, available },
          dedupeKey: `codes.low:${productId}:${today()}`,
          localized: { en: { title: `Codes running low: ${product.name}`, body: `${available} codes left.` }, ar: { title: `الأكواد قربت تخلص: ${product.name}`, body: `فاضل ${available} كود.` } },
        });
      }
    }
  } catch (err) {
    logger.error(`[digital] code pool alert: ${err.message}`);
  }
}

// Mounted under /api/v1/workspaces/:workspaceId/digital/code-alerts.
const router = Router({ mergeParams: true });
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
router.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: ws }), asyncHandler(async (req, res) => {
  res.json({ lowAt: lowAtOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] })) });
}));
router.put('/', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: ws, body: Joi.object({ lowAt: Joi.number().integer().min(0).max(100000).required() }) }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId);
  await w.update({ settings: { ...(w.settings || {}), license_codes_low_at: req.body.lowAt } });
  res.json({ lowAt: req.body.lowAt });
}));

module.exports = { checkPools, router, lowAtOf };
