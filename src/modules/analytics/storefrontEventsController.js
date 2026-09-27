'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./storefrontEventsService');

// 202: the batch is accepted; nothing about it is echoed back beyond the count.
const ingest = asyncHandler(async (req, res) => {
  const result = await service.ingest(req.tenant.workspaceId, req.body, { userAgent: req.get('user-agent') });
  res.status(202).json(result);
});

module.exports = { ingest };
