'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./analyticsController');
const schemas = require('./analyticsValidation');

// Mounted at /api/v1/workspaces/:workspaceId/analytics
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ANALYTICS_VIEW));

router.get('/overview', validate(schemas.overview), controller.overview);
router.get('/attribution', validate(schemas.attribution), controller.attribution);
// SPEC §15.4 names the profit report /analytics/pnl; it lives in modules/profit.
router.get('/pnl', (req, res) => res.redirect(307, req.originalUrl.replace('/analytics/pnl', '/profit/pnl')));
router.get('/summary', validate(schemas.summary), controller.summary);
router.get('/funnels', validate(schemas.funnels), controller.funnels);
router.get('/funnels/:funnelId', validate(schemas.funnelDetail), controller.funnelDetail);

// Web analytics (Umami port): pageviews/visitors/visits over analytics_events.
router.get('/web/stats', validate(schemas.webStats), controller.webStats);
router.get('/web/series', validate(schemas.webSeries), controller.webSeries);
router.get('/web/metrics', validate(schemas.webMetrics), controller.webMetrics);
router.get('/web/weekly', validate(schemas.webWeekly), controller.webWeekly);
router.get('/web/realtime', validate(schemas.webRealtime), controller.webRealtime);
// Live View on a world map: visitors, checkouts and orders of the last minutes by place (liveMap.js).
require('./liveMap').mount(router);
// Live view (SPEC §15.2): the snapshot the stream pushes, and the one-minute
// ticket that opens the stream at /api/v1/analytics-stream/:workspaceId (realtimeStream.js).
router.get('/live', validate(schemas.live), controller.live);
router.post('/live/stream-ticket', validate(schemas.liveTicket), controller.liveTicket);
// Sales, products, delivery and customers reports, insights and CSV export.
router.use('/reports', require('./reportsRoutes'));

module.exports = router;
