'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./analyticsService');
const funnelService = require('./funnelAnalyticsService');

const summary = asyncHandler(async (req, res) => {
  res.json({ summary: await service.getSummary(req.tenant.workspaceId, req.query) });
});

const funnels = asyncHandler(async (req, res) => {
  res.json(await funnelService.getFunnelsOverview(req.tenant.workspaceId, req.query));
});

const funnelDetail = asyncHandler(async (req, res) => {
  res.json(await funnelService.getFunnelDetail(req.tenant.workspaceId, req.params.funnelId, req.query));
});

module.exports = { summary, funnels, funnelDetail };

// --- Web analytics (Umami port) --------------------------------------------
const web = require('./webAnalyticsService');

const webStats = asyncHandler(async (req, res) => {
  res.json(await web.getStats(req.tenant.workspaceId, req.query));
});
const webSeries = asyncHandler(async (req, res) => {
  res.json(await web.getSeries(req.tenant.workspaceId, req.query));
});
const webMetrics = asyncHandler(async (req, res) => {
  res.json(await web.getMetrics(req.tenant.workspaceId, req.query));
});
const webWeekly = asyncHandler(async (req, res) => {
  res.json(await web.getWeekly(req.tenant.workspaceId, req.query));
});
const webRealtime = asyncHandler(async (req, res) => {
  res.json(await web.getRealtime(req.tenant.workspaceId, req.query));
});

Object.assign(module.exports, { webStats, webSeries, webMetrics, webWeekly, webRealtime });

// --- Dashboard home (SPEC §15.1) ---------------------------------------------
const overviewService = require('./overviewService');

const overview = asyncHandler(async (req, res) => {
  res.json({ overview: await overviewService.getOverview(req.tenant.workspaceId, req.query) });
});

Object.assign(module.exports, { overview });

// --- Sales attribution (SPEC §15.3) ------------------------------------------
const attributionService = require('./attributionService');

const attribution = asyncHandler(async (req, res) => {
  res.json({ attribution: await attributionService.getAttribution(req.tenant.workspaceId, req.query) });
});

Object.assign(module.exports, { attribution });

// --- Live view over SSE (SPEC §15.2) -----------------------------------------
const realtimeStream = require('./realtimeStream');

const live = asyncHandler(async (req, res) => {
  res.json(await realtimeStream.snapshot(req.tenant.workspaceId, { funnelId: req.query.funnelId }));
});
const liveTicket = asyncHandler(async (req, res) => {
  res.status(201).json({
    ticket: realtimeStream.issueTicket(req.tenant.workspaceId, req.user.id),
    expiresInSeconds: realtimeStream.TICKET_TTL_MS / 1000,
  });
});

Object.assign(module.exports, { live, liveTicket });
