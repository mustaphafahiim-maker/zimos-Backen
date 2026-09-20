'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformAdmin } = require('../../core/middleware/platformAdminGuard');
const controller = require('./platformOpsController');
const schemas = require('./platformOpsValidation');

// Mounted at /api/v1/admin, sharing the mount with billing's adminRoutes
// (which owns /workspaces and /dashboard) and platformAdminRoutes (which owns
// /plans, /subscriptions, /feature-flags and /announcements). This router
// covers the operational side: overview, a single workspace, users, the
// cross-tenant audit log, templates and system health. Platform admin only —
// no workspace RBAC applies, so the guard runs for every route here.
const router = Router();
router.use(authenticate, requirePlatformAdmin);

// --- Overview ------------------------------------------------------------
router.get('/overview', controller.getOverview);

// --- Workspaces ----------------------------------------------------------
// The list lives in billing's adminRoutes; this is the per-workspace detail.
router.get('/workspaces/:workspaceId', validate(schemas.workspaceDetail), controller.getWorkspace);
router.patch('/workspaces/:workspaceId/status', validate(schemas.setWorkspaceStatus), controller.setWorkspaceStatus);
router.patch(
  '/workspaces/:workspaceId/subscription',
  validate(schemas.updateSubscription),
  controller.updateSubscription
);

// --- Users ---------------------------------------------------------------
router.get('/users', validate(schemas.listUsers), controller.listUsers);
router.patch('/users/:userId', validate(schemas.updateUser), controller.updateUser);

// --- Audit log -----------------------------------------------------------
router.get('/audit-logs', validate(schemas.listAuditLogs), controller.listAuditLogs);

// --- Templates -----------------------------------------------------------
router.get('/templates', controller.listTemplates);
router.patch('/templates/:templateId', validate(schemas.updateTemplate), controller.updateTemplate);

// --- System --------------------------------------------------------------
router.get('/system', controller.getSystem);

module.exports = router;
