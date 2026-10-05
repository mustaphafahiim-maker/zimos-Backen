'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./merchantNotificationService');

const wid = (req) => req.tenant.workspaceId;
const uid = (req) => req.user.id;

const list = asyncHandler(async (req, res) => res.json(await service.list(wid(req), uid(req), req.query)));

const summary = asyncHandler(async (req, res) => res.json(await service.summary(wid(req), uid(req))));

const markRead = asyncHandler(async (req, res) =>
  res.json(await service.markRead(wid(req), uid(req), req.params.notificationId))
);

const markAllRead = asyncHandler(async (req, res) => res.json(await service.markAllRead(wid(req), uid(req))));

const getPreferences = asyncHandler(async (req, res) =>
  res.json(await service.getPreferences(wid(req), uid(req), req.tenant.role))
);

const updatePreferences = asyncHandler(async (req, res) =>
  res.json(await service.updatePreferences(wid(req), uid(req), req.tenant.role, req.body, req))
);

module.exports = { list, summary, markRead, markAllRead, getPreferences, updatePreferences };
