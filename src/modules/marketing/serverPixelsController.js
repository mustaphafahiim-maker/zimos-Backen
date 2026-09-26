'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./serverPixelsService');

const getIntegration = asyncHandler(async (req, res) => {
  res.json({ integration: service.integrationView(await service.getIntegration(req.tenant.workspaceId)) });
});
const connect = asyncHandler(async (req, res) => {
  const integration = await service.connect(req.tenant.workspaceId, req.body, req);
  res.json({ integration: service.integrationView(integration) });
});
const disconnect = asyncHandler(async (req, res) => {
  res.json(await service.disconnect(req.tenant.workspaceId, req));
});

module.exports = { getIntegration, connect, disconnect };
