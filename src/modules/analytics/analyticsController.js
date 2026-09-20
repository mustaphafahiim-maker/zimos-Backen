'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./analyticsService');

const summary = asyncHandler(async (req, res) => {
  res.json({ summary: await service.getSummary(req.tenant.workspaceId, req.query) });
});

module.exports = { summary };
