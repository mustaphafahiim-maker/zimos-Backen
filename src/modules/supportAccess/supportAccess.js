'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AuthorizationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Support access (SPEC §17.2): the merchant lets the ZIMOS team into the store
 * for a set time and can take it back at any moment. Without an active grant
 * nobody at the platform may open the store's data — anything that acts
 * inside a store on behalf of support calls `assertGranted` first, and that
 * use is written to the store's activity log.
 *
 * Staff routes mounted at /api/v1/workspaces/:workspaceId/support-access
 * (workspace.manage).
 */

const HOURS = [1, 4, 24, 72, 168];

const view = (grant) => ({
  id: grant.id,
  note: grant.note,
  expiresAt: grant.expiresAt,
  revokedAt: grant.revokedAt,
  lastUsedAt: grant.lastUsedAt,
  createdAt: grant.createdAt,
  active: !grant.revokedAt && grant.expiresAt > new Date(),
});

function activeGrant(workspaceId) {
  return db.SupportAccessGrant.findOne({
    where: { workspaceId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [['expiresAt', 'DESC']],
  });
}

/** Throws 403 SUPPORT_ACCESS_NOT_GRANTED unless the merchant has let support in right now. */
async function assertGranted(workspaceId, { adminUserId = null, reason = null, req = null } = {}) {
  const grant = await activeGrant(workspaceId);
  if (!grant) {
    const err = new AuthorizationError('The merchant has not given support access to this store');
    err.code = 'SUPPORT_ACCESS_NOT_GRANTED';
    throw err;
  }
  await grant.update({ lastUsedAt: new Date() });
  await recordAudit({ workspaceId, actorUserId: adminUserId, action: 'support.access_used', entityType: 'SupportAccessGrant', entityId: grant.id, metadata: { reason }, req });
  return grant;
}

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WORKSPACE_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };

router.get(
  '/',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const grants = await db.SupportAccessGrant.findAll({ where: { workspaceId: req.tenant.workspaceId }, order: [['createdAt', 'DESC']], limit: 10 });
    const active = grants.find((grant) => !grant.revokedAt && grant.expiresAt > new Date()) || null;
    res.json({ active: active ? view(active) : null, history: grants.map(view), durations: HOURS });
  })
);

router.post(
  '/',
  validate({
    params: Joi.object(ws),
    body: Joi.object({ hours: Joi.number().valid(...HOURS).required(), note: Joi.string().trim().max(300).allow('').optional() }),
  }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    // One grant at a time: a new one replaces what is still open.
    await db.SupportAccessGrant.update(
      { revokedAt: new Date(), revokedByUserId: req.user.id },
      { where: { workspaceId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } } }
    );
    const grant = await db.SupportAccessGrant.create({
      workspaceId,
      grantedByUserId: req.user.id,
      note: req.body.note || null,
      expiresAt: new Date(Date.now() + req.body.hours * 3600 * 1000),
    });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'support.access_grant', entityType: 'SupportAccessGrant', entityId: grant.id, after: { hours: req.body.hours, expiresAt: grant.expiresAt }, req });
    res.status(201).json({ active: view(grant) });
  })
);

router.delete(
  '/',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const grant = await activeGrant(workspaceId);
    if (grant) {
      await grant.update({ revokedAt: new Date(), revokedByUserId: req.user.id });
      await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'support.access_revoke', entityType: 'SupportAccessGrant', entityId: grant.id, req });
    }
    res.json({ active: null });
  })
);

module.exports = { router, assertGranted, activeGrant, view };
