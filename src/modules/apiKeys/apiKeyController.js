'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./apiKeyService');

const wid = (req) => req.tenant.workspaceId;

const list = asyncHandler(async (req, res) => res.json(await service.listKeys(wid(req))));

const create = asyncHandler(async (req, res) => res.status(201).json(await service.createKey(wid(req), req.body, req)));

const revoke = asyncHandler(async (req, res) =>
  res.json({ apiKey: await service.revokeKey(wid(req), req.params.keyId, req) })
);

module.exports = { list, create, revoke };
