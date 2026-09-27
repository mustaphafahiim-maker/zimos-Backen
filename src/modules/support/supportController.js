'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./supportService');

// Merchant side. req.tenant.workspaceId is the only workspace id trusted here.

const list = asyncHandler(async (req, res) => {
  res.json({ tickets: await service.listWorkspaceTickets(req.tenant.workspaceId) });
});

const open = asyncHandler(async (req, res) => {
  res.status(201).json(await service.openTicket(req.tenant.workspaceId, req.body, req));
});

const get = asyncHandler(async (req, res) => {
  res.json(await service.getWorkspaceTicket(req.tenant.workspaceId, req.params.ticketId));
});

const reply = asyncHandler(async (req, res) => {
  res.status(201).json(await service.merchantReply(req.tenant.workspaceId, req.params.ticketId, req.body, req));
});

module.exports = { list, open, get, reply };
