'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./trackingPixelService');

const wid = (req) => req.tenant.workspaceId;

const list = asyncHandler(async (req, res) => res.json(await service.list(wid(req))));

const create = asyncHandler(async (req, res) => res.status(201).json({ pixel: await service.create(wid(req), req.body, req) }));

const update = asyncHandler(async (req, res) =>
  res.json({ pixel: await service.update(wid(req), req.params.pixelId, req.body, req) })
);

const remove = asyncHandler(async (req, res) => res.json(await service.remove(wid(req), req.params.pixelId, req)));

module.exports = { list, create, update, remove };
