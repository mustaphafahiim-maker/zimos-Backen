'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./trackingPixelService');
const pixelEventLog = require('./pixelEventLog');
const browserEventRelay = require('./browserEventRelay');
const purchaseTiming = require('./purchaseTiming');

const wid = (req) => req.tenant.workspaceId;

const list = asyncHandler(async (req, res) => res.json(await service.list(wid(req))));

const create = asyncHandler(async (req, res) => res.status(201).json({ pixel: await service.create(wid(req), req.body, req) }));

const update = asyncHandler(async (req, res) =>
  res.json({ pixel: await service.update(wid(req), req.params.pixelId, req.body, req) })
);

const remove = asyncHandler(async (req, res) => res.json(await service.remove(wid(req), req.params.pixelId, req)));

const events = asyncHandler(async (req, res) => res.json(await pixelEventLog.list(wid(req), req.query)));

const sendTest = asyncHandler(async (req, res) => res.json(await browserEventRelay.sendTest(wid(req), req.params.pixelId, req)));

const getSettings = asyncHandler(async (req, res) => res.json(await purchaseTiming.getSettings(wid(req))));

const updateSettings = asyncHandler(async (req, res) => res.json(await purchaseTiming.updateSettings(wid(req), req.body, req)));

module.exports = { list, create, update, remove, events, sendTest, getSettings, updateSettings };
