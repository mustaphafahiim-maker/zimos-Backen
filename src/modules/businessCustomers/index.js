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

/*
 * Business customers (spec-gaps item 228): a company name and tax ID on a
 * customer, and a tax exemption the store grants.
 *
 * - The shopper may fill in their company and tax ID from their account; only
 *   the store can mark a customer tax-exempt (with a note, e.g. the
 *   certificate seen).
 * - The exemption applies to an order placed by that customer signed in
 *   (X-Shopper-Token, and the order is theirs), or entered by the team for
 *   them. A typed phone number proves nothing, so a guest checkout never gets
 *   it. Exempt = no tax added on top; a price that includes tax stays as it is.
 * - The order keeps the company, tax ID and exemption in its contact snapshot,
 *   and the invoice prints them under "Bill to".
 */

const TAX_EXEMPT = Symbol.for('zimos.taxExemptCustomer');

/** orderService: does this order go without added tax? */
function exemptFor(customer, payload, req) {
  if (!customer || !customer.taxExempt) return false;
  if (payload && payload[TAX_EXEMPT] === customer.id) return true;
  return Boolean(req && req.user && req.user.id);
}

/** orderService: the contact snapshot with the business details. */
function withBusiness(contact, customer, taxExempt) {
  if (!customer || (!customer.companyName && !customer.taxId && !taxExempt)) return contact;
  return { ...contact, ...(customer.companyName ? { company: customer.companyName } : {}), ...(customer.taxId ? { taxId: customer.taxId } : {}), ...(taxExempt ? { taxExempt: true } : {}) };
}

/** Checkout: marks the payload for a signed-in exempt shopper. */
async function markCheckout(workspaceId, shopperToken, orderBody) {
  if (!shopperToken) return;
  const shopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, shopperToken);
  if (shopper && shopper.taxExempt) orderBody[TAX_EXEMPT] = shopper.id;
}

const view = (c) => ({ companyName: c.companyName, taxId: c.taxId, taxExempt: c.taxExempt, taxExemptNote: c.taxExemptNote });
const text = (max) => Joi.string().trim().max(max).allow('', null);
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Mounted at /api/v1/workspaces/:workspaceId/customers/:customerId/business.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const params = Joi.object({ workspaceId: Joi.string().uuid().required(), customerId: Joi.string().uuid().required() });
async function findCustomer(req) {
  const c = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId } });
  if (!c) throw new NotFoundError('Customer');
  return c;
}
staff.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params }), asyncHandler(async (req, res) => res.json(view(await findCustomer(req)))));
staff.put(
  '/',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ params, body: Joi.object({ companyName: text(200), taxId: text(40), taxExempt: Joi.boolean(), taxExemptNote: text(300) }) }),
  asyncHandler(async (req, res) => {
    const c = await findCustomer(req);
    const before = view(c);
    const next = {};
    for (const k of ['companyName', 'taxId', 'taxExemptNote']) if (req.body[k] !== undefined) next[k] = clean(req.body[k]);
    if (req.body.taxExempt !== undefined) next.taxExempt = req.body.taxExempt;
    await c.update(next);
    await recordAudit({ workspaceId: c.workspaceId, actorUserId: req.user.id, action: 'customer.business_update', entityType: 'Customer', entityId: c.id, before, after: view(c), req });
    res.json(view(c));
  })
);

// Mounted at /api/v1/store/:workspaceId/account/business — the signed-in shopper's own details.
const account = Router({ mergeParams: true });
account.use(resolvePublicWorkspace);
async function shopperOf(req) {
  const c = await require('../shopperAccounts/shopperAuth').readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!c) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  return c;
}
const shopperView = (c) => ({ companyName: c.companyName, taxId: c.taxId, taxExempt: c.taxExempt });
account.get('/', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(shopperView(await shopperOf(req)));
}));
account.put('/', validate({ body: Joi.object({ companyName: text(200), taxId: text(40) }) }), asyncHandler(async (req, res) => {
  const c = await shopperOf(req);
  const next = {};
  for (const k of ['companyName', 'taxId']) if (req.body[k] !== undefined) next[k] = clean(req.body[k]);
  // A changed tax ID needs the store to look again before the exemption carries over.
  if (next.taxId !== undefined && next.taxId !== c.taxId && c.taxExempt) next.taxExempt = false;
  await c.update(next);
  res.set('Cache-Control', 'private, no-store');
  res.json(shopperView(c));
}));

module.exports = { staff, account, exemptFor, withBusiness, markCheckout, TAX_EXEMPT };
