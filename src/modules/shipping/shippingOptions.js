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

/**
 * Shipping options the shopper chooses between (SPEC §12.1 "more than one
 * option for the customer — standard, express, branch pickup — with
 * different prices and durations").
 *
 *   standard   always there: the price the store's rates give (groups, free
 *              shipping and all). Only its name and delivery time are set here.
 *   extra      each with `mode`:
 *                add    the standard price plus `amount` (express)
 *                fixed  exactly `amount`, whatever the rates say (pickup = 0)
 *
 * Stored in settings.shipping_options. A store with no extra option behaves
 * exactly as before: the checkout shows no choice and charges the standard.
 *
 * Mounted at /api/v1/workspaces/:workspaceId/shipping/options.
 */

const STANDARD = 'standard';
const text = (max) => Joi.string().trim().max(max).allow('', null);
const days = Joi.number().integer().min(0).max(90).allow(null);
const settingsSchema = Joi.object({
  standard: Joi.object({ nameAr: text(80), nameEn: text(80), daysMin: days, daysMax: days }).default({}),
  extra: Joi.array()
    .items(
      Joi.object({
        key: Joi.string().trim().lowercase().pattern(/^[a-z0-9_-]{2,40}$/).invalid(STANDARD).required(),
        nameAr: text(80),
        nameEn: text(80),
        mode: Joi.string().valid('add', 'fixed').required(),
        amount: Joi.number().integer().min(0).required(),
        daysMin: days,
        daysMax: days,
        active: Joi.boolean().default(true),
      })
    )
    .max(5)
    .unique('key')
    .default([]),
});

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function stored(settings) {
  const raw = (settings && settings.shipping_options) || {};
  const s = raw.standard || {};
  return {
    standard: { nameAr: clean(s.nameAr), nameEn: clean(s.nameEn), daysMin: s.daysMin ?? null, daysMax: s.daysMax ?? null },
    extra: (Array.isArray(raw.extra) ? raw.extra : []).map((o) => ({
      key: o.key,
      nameAr: clean(o.nameAr),
      nameEn: clean(o.nameEn),
      mode: o.mode === 'fixed' ? 'fixed' : 'add',
      amount: Number(o.amount) || 0,
      daysMin: o.daysMin ?? null,
      daysMax: o.daysMax ?? null,
      active: o.active !== false,
    })),
  };
}

/** The options a shopper sees for a priced cart ({ amount, rule } from calculateShippingAmount). Empty = no choice. */
function optionsFor(settings, shipping) {
  const { standard, extra } = stored(settings);
  const live = extra.filter((o) => o.active);
  // No destination yet, or no extra option: nothing to choose. The extra
  // options' amounts are in the store's currency: a funnel selling in another
  // one (shipping.ownCurrency, funnels/funnelShipping.js) has none.
  if (live.length === 0 || !shipping || shipping.rule === 'no_destination' || shipping.ownCurrency) return [];
  const base = Number(shipping.amount) || 0;
  return [
    { key: STANDARD, nameAr: standard.nameAr, nameEn: standard.nameEn, amount: base, daysMin: standard.daysMin, daysMax: standard.daysMax },
    ...live.map((o) => ({
      key: o.key,
      nameAr: o.nameAr,
      nameEn: o.nameEn,
      amount: o.mode === 'fixed' ? o.amount : base + o.amount,
      daysMin: o.daysMin,
      daysMax: o.daysMax,
    })),
  ];
}

/**
 * createOrder's hook: the chosen option for the priced cart, or null for the
 * standard price. An unknown or switched-off key is refused (the shopper saw
 * a choice that no longer exists).
 */
async function choose(workspaceId, key, shipping, transaction) {
  if (!key || key === STANDARD) return null;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['settings'], transaction });
  const option = optionsFor(workspace && workspace.settings, shipping).find((o) => o.key === key);
  if (!option) {
    throw new ValidationError([{ field: 'shippingOption', message: 'This shipping option is not available — choose another one' }]);
  }
  return { amount: option.amount, snapshot: { key: option.key, nameAr: option.nameAr, nameEn: option.nameEn, daysMin: option.daysMin, daysMax: option.daysMax } };
}

/** For the quote: the options with their amounts. */
async function quoteOptions(workspaceId, shipping) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['settings'] });
  return optionsFor(workspace && workspace.settings, shipping);
}

// ---------------------------------------------------------------- routes --

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };

router.get(
  '/',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] });
    res.json({ options: stored(workspace.settings) });
  })
);

router.put(
  '/',
  validate({ params: Joi.object(ws), body: settingsSchema }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const before = stored(workspace.settings);
    await workspace.update({ settings: { ...(workspace.settings || {}), shipping_options: req.body } });
    const after = stored(workspace.settings);
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'shipping.options_update', entityType: 'Workspace', entityId: workspace.id, before, after, req });
    res.json({ options: after });
  })
);

module.exports = { router, choose, quoteOptions, optionsFor, STANDARD };
