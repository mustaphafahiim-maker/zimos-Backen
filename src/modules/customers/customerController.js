'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./customerService');

const { forViewer } = require('../../core/utils/phoneMask');

// Phones in the list are masked for roles without customers.reveal_sensitive.
const list = asyncHandler(async (req, res) => res.json(forViewer(req, await service.listCustomers(req.tenant.workspaceId, req.query))));
const get = asyncHandler(async (req, res) => {
  const canRevealSensitive = req.tenant.hasPermission('customers.reveal_sensitive');
  const customer = canRevealSensitive
    ? await service.revealSensitive(req.tenant.workspaceId, req.params.customerId, req)
    : await service.getCustomer(req.tenant.workspaceId, req.params.customerId);
  res.json({ customer });
});
const update = asyncHandler(async (req, res) => res.json({ customer: await service.updateCustomer(req.tenant.workspaceId, req.params.customerId, req.body, req) }));
const blacklist = asyncHandler(async (req, res) => res.json({ customer: await service.setBlacklist(req.tenant.workspaceId, req.params.customerId, req.body, req) }));
const addAddress = asyncHandler(async (req, res) => res.status(201).json({ address: await service.addAddress(req.tenant.workspaceId, req.params.customerId, req.body, req) }));
const updateAddress = asyncHandler(async (req, res) => res.json({ address: await service.updateAddress(req.tenant.workspaceId, req.params.customerId, req.params.addressId, req.body, req) }));

module.exports = { list, get, update, blacklist, addAddress, updateAddress };
