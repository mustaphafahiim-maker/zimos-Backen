'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { storefrontPostLimiters } = require('../../core/middleware/rateLimiters');
const { recordAudit } = require('../audit/auditService');
const svc = require('./giftCardService');

// Routes for gift cards (giftCardService.js, spec-gaps item 189).

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const money = Joi.number().integer().min(1).max(100000000);

// Mounted at /api/v1/store/:workspaceId/gift-cards — the balance check (rate-limited per shopper IP).
const store = Router({ mergeParams: true });
store.post(
  '/check',
  storefrontPostLimiters.giftCardCheck,
  resolvePublicWorkspace,
  validate({ params: Joi.object({ workspaceId: Joi.string().required() }), body: Joi.object({ code: Joi.string().trim().min(4).max(40).required() }) }),
  asyncHandler(async (req, res) => res.json({ giftCard: await svc.check(req.publicWorkspace.id, req.body.code) }))
);

// Mounted at /api/v1/workspaces/:workspaceId/gift-cards (discounts.manage).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.DISCOUNTS_MANAGE));
const wid = (req) => req.tenant.workspaceId;

staff.get('/settings', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(svc.settingsOf(await db.Workspace.findByPk(wid(req), { attributes: ['id', 'settings'] })))));
staff.put(
  '/settings',
  validate({ params: Joi.object(ws), body: Joi.object({ productIds: Joi.array().items(uuid).max(50).unique().required(), validityDays: Joi.number().integer().min(1).max(3650).allow(null) }) }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(wid(req));
    const found = await db.Product.count({ where: { id: req.body.productIds, workspaceId: workspace.id } });
    if (found !== req.body.productIds.length) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Some products are not in this store', details: [{ field: 'productIds', message: 'Pick products of this store' }] } });
    const before = svc.settingsOf(workspace);
    const next = { productIds: req.body.productIds, validityDays: req.body.validityDays ?? null };
    await workspace.update({ settings: { ...(workspace.settings || {}), gift_cards: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'gift_cards.settings', entityType: 'Workspace', entityId: workspace.id, before, after: next, req });
    return res.json(next);
  })
);
staff.get(
  '/',
  validate({ params: Joi.object(ws), query: Joi.object({ state: Joi.string().valid('active', 'empty', 'expired', 'disabled'), q: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso() }) }),
  asyncHandler(async (req, res) => res.json(await svc.list(wid(req), req.query)))
);
staff.post(
  '/',
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      amount: money.required(),
      currency: Joi.string().length(3).uppercase().required(),
      expiresAt: Joi.date().iso().greater('now').allow(null),
      recipientName: Joi.string().trim().max(200).allow('', null),
      recipientEmail: Joi.string().trim().email().max(255).allow('', null),
      message: Joi.string().trim().max(500).allow('', null),
      note: Joi.string().trim().max(500).allow('', null),
      sendEmail: Joi.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json(await svc.issue(wid(req), { ...req.body, recipientEmail: req.body.recipientEmail || null }, { actorUserId: req.user.id, req })))
);
const withId = Joi.object({ ...ws, giftCardId: uuid.required() });
staff.get('/:giftCardId', validate({ params: withId }), asyncHandler(async (req, res) => res.json(await svc.get(wid(req), req.params.giftCardId))));
staff.patch(
  '/:giftCardId',
  validate({
    params: withId,
    body: Joi.object({
      status: Joi.string().valid('active', 'disabled'),
      expiresAt: Joi.date().iso().allow(null),
      note: Joi.string().trim().max(500).allow('', null),
      recipientName: Joi.string().trim().max(200).allow('', null),
      recipientEmail: Joi.string().trim().email().max(255).allow('', null),
      adjustBy: Joi.number().integer().min(-100000000).max(100000000).invalid(0),
      adjustNote: Joi.string().trim().max(300).allow('', null),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json(await svc.update(wid(req), req.params.giftCardId, req.body, req)))
);
staff.post('/:giftCardId/code', validate({ params: withId, body: Joi.object({ resend: Joi.boolean().default(false) }) }), asyncHandler(async (req, res) => res.json(await svc.revealCode(wid(req), req.params.giftCardId, req.body, req))));

module.exports = { store, staff };
