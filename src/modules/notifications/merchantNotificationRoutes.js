'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const controller = require('./merchantNotificationController');
const schemas = require('./merchantNotificationValidation');

// Mounted at /api/v1/workspaces/:workspaceId/notifications. A teammate's own
// bell: every active member may read it, so there is no requirePermission
// here — the permission each notification type needs is applied when it is
// delivered (merchantNotificationService.create).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/', validate(schemas.list), controller.list);
router.get('/summary', validate(schemas.workspaceOnly), controller.summary);
router.post('/read-all', validate(schemas.workspaceOnly), controller.markAllRead);
router.get('/preferences', validate(schemas.workspaceOnly), controller.getPreferences);
router.put('/preferences', validate(schemas.updatePreferences), controller.updatePreferences);
router.post('/:notificationId/read', validate(schemas.markRead), controller.markRead);

module.exports = router;
