'use strict';

const { Router } = require('express');
const { authenticate } = require('../../core/middleware/authenticate');
const { authenticateFlexible } = require('../../core/middleware/authenticateFlexible');
const { requirePlatformPermission } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS } = require('../../core/security/platformPermissions');
const controller = require('./billingController');

// Mounted at /api/v1/admin
const router = Router();
const canViewWorkspaces = requirePlatformPermission(PLATFORM_PERMISSIONS.WORKSPACES_VIEW);

router.get('/workspaces', authenticate, canViewWorkspaces, controller.adminWorkspaces);
// HTML dashboard — authenticateFlexible so it opens in a browser (?token=).
router.get('/dashboard', authenticateFlexible, canViewWorkspaces, controller.adminDashboard);

module.exports = router;
