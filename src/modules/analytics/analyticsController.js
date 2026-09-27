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
