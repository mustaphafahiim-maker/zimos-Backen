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
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const svc = require('./storeCreditService');

// Store credit (spec-gaps item 204) — see storeCreditService.js.

// Mounted at /api/v1/workspaces/:workspaceId/store-credit.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const cust = Joi.object({ ...ws, customerId: Joi.string().uuid().required() });
staff.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  res.json({ spendingEnabled: svc.spendingOn(workspace), ...(await svc.listHolders(req.tenant.workspaceId)) });
}));
staff.put('/settings', requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), validate({ params: Joi.object(ws), body: Joi.object({ enabled: Joi.boolean().required() }) }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
  await workspace.update({ settings: { ...(workspace.settings || {}), store_credit: { enabled: req.body.enabled } } });
  await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'store_credit.settings', entityType: 'Workspace', entityId: workspace.id, after: req.body, req });
  res.json({ spendingEnabled: svc.spendingOn(workspace) });
}));
staff.get('/customers/:customerId', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: cust }), asyncHandler(async (req, res) => {
  const customer = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId } });
  if (!customer) throw new NotFoundError('Customer');
  res.json(await svc.accountOf(customer, 200));
}));
staff.post(
  '/customers/:customerId/adjust',
  requirePermission(PERMISSIONS.REFUNDS_MANAGE),
  validate({ params: cust, body: Joi.object({ amount: Joi.number().integer().min(-100000000).max(100000000).invalid(0).required(), note: Joi.string().trim().min(1).max(200).required() }) }),
  asyncHandler(async (req, res) => res.json(await svc.adjust(req.tenant.workspaceId, req.params.customerId, req.body.amount, req.body.note, req)))
);
// An order refunded as store credit instead of money.
staff.post(
  '/orders/:orderId/refund',
  requirePermission(PERMISSIONS.REFUNDS_MANAGE),
  validate({ params: Joi.object({ ...ws, orderId: Joi.string().uuid().required() }), body: Joi.object({ amount: Joi.number().integer().min(1).required(), reason: Joi.string().trim().min(1).max(300).required() }) }),
  asyncHandler(async (req, res) => res.status(201).json(await svc.refundToCredit(req.tenant.workspaceId, req.params.orderId, req.body, req)))
);

// Mounted at /api/v1/store/:workspaceId/account/store-credit — the signed-in shopper's balance.
const account = Router({ mergeParams: true });
account.get('/', resolvePublicWorkspace, validate({ params: Joi.object({ workspaceId: Joi.string().required() }) }), asyncHandler(async (req, res) => {
  const customer = await require('../shopperAccounts/shopperAuth').readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!customer) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  res.json({ spendingEnabled: svc.spendingOn(req.publicWorkspace), ...(await svc.accountOf(customer)) });
}));

module.exports = { staff, account };
