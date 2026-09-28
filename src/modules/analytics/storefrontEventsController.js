'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./storefrontEventsService');

// 202: the batch is accepted; nothing about it is echoed back beyond the count
// (and `bot: true` when the User-Agent is a known crawler and nothing was stored).
const ingest = asyncHandler(async (req, res) => {
  const result = await service.ingest(req.tenant.workspaceId, req.body, {
    userAgent: req.get('user-agent'),
    getHeader: (name) => req.get(name),
  });
  res.status(202).json(result);
});

module.exports = { ingest };
