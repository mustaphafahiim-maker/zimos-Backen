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

/** Workspace activity log, newest first (`before` = createdAt of the last row seen). */
const listAuditLogs = asyncHandler(async (req, res) => {
  const { limit, before, entityType, action, actorUserId, from } = req.query;
  const where = { workspaceId: req.tenant.workspaceId };
  if (before || from) where.createdAt = { ...(before ? { [Op.lt]: new Date(before) } : {}), ...(from ? { [Op.gte]: new Date(from) } : {}) };
  if (actorUserId) where.actorUserId = actorUserId;
  if (entityType) where.entityType = entityType;
  if (action) where.action = { [Op.iLike]: `${action}%` };

  const rows = await db.AuditLog.findAll({ where, order: [['createdAt', 'DESC']], limit });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))];
  const users = actorIds.length ? await db.User.findAll({ where: { id: actorIds }, attributes: ['id', 'fullName', 'email'] }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  res.json({
    logs: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      createdAt: r.createdAt,
      ipAddress: r.ipAddress,
      actor: r.actorUserId && byId.get(r.actorUserId) ? { id: r.actorUserId, fullName: byId.get(r.actorUserId).fullName, email: byId.get(r.actorUserId).email } : null,
      before: r.beforeState,
      after: r.afterState,
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

// Mounted at /api/v1/workspaces/:workspaceId/audit-logs
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.AUDIT_LOG_VIEW));
router.get(
  '/',
  validate({
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      before: Joi.date().iso().optional(),
      entityType: Joi.string().max(100).optional(),
      action: Joi.string().max(100).optional(),
      actorUserId: Joi.string().uuid().optional(),
      from: Joi.date().iso().optional(),
    }),
  }),
  listAuditLogs
);

module.exports = router;
