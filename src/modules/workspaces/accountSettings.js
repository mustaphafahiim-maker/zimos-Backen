'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const joiEmail = require('../../core/utils/joiEmail');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Account settings (SPEC §17.3) that had no home yet:
 *
 *   timezone           the store's clock (workspaces.timezone): reports,
 *                      exports and daily rollups count days on it
 *   contactFormEmail   where each contact-form message is emailed
 *                      (contacts/jobs.js); empty = the bell only
 *   legal              the business on invoices: name, company, phone,
 *                      address, country (orders/orderInvoicePdf.js)
 *
 * Stored in settings.account (and the timezone column); the account name,
 * picture, owner email and subdomain stay where they already are.
 *
 * Mounted at /api/v1/workspaces/:workspaceId/account-settings.
 */

const ws = { workspaceId: Joi.string().uuid().required() };
const text = (max) => Joi.string().trim().max(max).allow('', null);

const validTimeZone = (value, helpers) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return helpers.message('"timezone" must be an IANA time zone such as Africa/Cairo');
  }
};

const body = Joi.object({
  timezone: Joi.string().max(64).custom(validTimeZone),
  contactFormEmail: joiEmail().allow('', null),
  legal: Joi.object({
    name: text(200),
    company: text(200),
    phone: text(32),
    address: text(500),
    country: Joi.string().trim().length(2).uppercase().allow('', null),
  }),
}).min(1);

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** settings.account with every key present. */
function accountOf(workspace) {
  const a = (workspace.settings && workspace.settings.account) || {};
  const legal = a.legal || {};
  return {
    timezone: workspace.timezone || 'UTC',
    contactFormEmail: clean(a.contact_form_email),
    legal: {
      name: clean(legal.name),
      company: clean(legal.company),
      phone: clean(legal.phone),
      address: clean(legal.address),
      country: clean(legal.country),
    },
  };
}

async function load(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  return workspace;
}

async function save(workspaceId, input, req) {
  const workspace = await load(workspaceId);
  const before = accountOf(workspace);
  const stored = { ...((workspace.settings && workspace.settings.account) || {}) };
  if (input.contactFormEmail !== undefined) stored.contact_form_email = clean(input.contactFormEmail);
  if (input.legal) stored.legal = { ...(stored.legal || {}), ...Object.fromEntries(Object.entries(input.legal).map(([k, v]) => [k, clean(v)])) };
  const values = { settings: { ...(workspace.settings || {}), account: stored } };
  if (input.timezone) values.timezone = input.timezone;
  await workspace.update(values);
  // Daily rollups are counted on the store's days: a new clock recounts them (analytics/analyticsDaily.js).
  if (values.timezone && values.timezone !== before.timezone) await db.AnalyticsDaily.destroy({ where: { workspaceId } });
  const after = accountOf(workspace);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'workspace.account_settings_update', entityType: 'Workspace', entityId: workspaceId, before, after, req });
  return after;
}

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

// The store's previous addresses, which still send visitors to the current one (slugHistory.js).
router.get(
  '/previous-addresses',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ addresses: await require('./slugHistory').listFor(req.tenant.workspaceId) }))
);

router.get(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ account: accountOf(await load(req.tenant.workspaceId)) }))
);

router.put(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws), body }),
  asyncHandler(async (req, res) => res.json({ account: await save(req.tenant.workspaceId, req.body, req) }))
);

module.exports = { router, accountOf };
