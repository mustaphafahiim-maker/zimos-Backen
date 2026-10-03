'use strict';
const asyncHandler = require('express-async-handler');
const networkStats = require('./networkStats');

const score = asyncHandler(async (req, res) =>
  res.json(await networkStats.scoreForCustomer(req.tenant.workspaceId, req.params.customerId))
);
const scores = asyncHandler(async (req, res) =>
  res.json(await networkStats.scoresForCustomers(req.tenant.workspaceId, req.body.customerIds))
);
const reportSpam = asyncHandler(async (req, res) =>
  res.json(await networkStats.reportSpam(req.tenant.workspaceId, req.params.customerId, req))
);

module.exports = { score, scores, reportSpam };
