'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace, refuseDraftOrders } = require('../../core/middleware/publicWorkspace');
const controller = require('./funnelsController');
const schemas = require('./funnelsValidation');

// Public funnel runtime. No staff auth: only "does this workspace exist and
// is it live" via resolvePublicWorkspace, same as the storefront/pages
// public routes. Mounted at /api/v1/store/:workspaceId/funnels
const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

// Enter (or resume) a funnel by id or subdomain.
router.post('/:funnelRef/sessions', validate(schemas.startSession), controller.startSession);
// Render data for the session's current step, from the published snapshot.
router.get('/:funnelId/sessions/:sessionId/step', validate(schemas.sessionStep), controller.getSessionStep);
// Produce an outcome for the current step and route to the next one.
router.post('/:funnelId/sessions/:sessionId/advance', validate(schemas.advance), refuseDraftOrders, controller.advance);
// The funnel's generic pages — contact, about, policies — off the path (genericPages.js).
const genericPages = require('./genericPages');
router.get('/:funnelRef/pages', validate(genericPages.schemas.list), genericPages.list);
router.get('/:funnelRef/pages/:stepKey', validate(genericPages.schemas.one), genericPages.one);

module.exports = router;
