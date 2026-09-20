'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./platformOpsService');

// Every handler here sits behind `authenticate` + `requirePlatformAdmin`.
// Mutations hand the service the acting admin and the request so the audit
// entry carries the actor, IP and user agent.
const context = (req) => ({ actorUserId: req.user.id, req });

// --- Overview ------------------------------------------------------------
const getOverview = asyncHandler(async (req, res) => {
  res.json({ overview: await service.getOverview() });
});

// --- Workspaces ----------------------------------------------------------
const getWorkspace = asyncHandler(async (req, res) => {
  res.json({ workspace: await service.getWorkspace(req.params.workspaceId) });
});

const setWorkspaceStatus = asyncHandler(async (req, res) => {
  res.json({ workspace: await service.setWorkspaceStatus(req.params.workspaceId, req.body, context(req)) });
});

const updateSubscription = asyncHandler(async (req, res) => {
  res.json({ subscription: await service.updateSubscription(req.params.workspaceId, req.body, context(req)) });
});

// --- Users ---------------------------------------------------------------
const listUsers = asyncHandler(async (req, res) => {
  // `users` and `nextCursor` together — the list is cursor-paginated.
  res.json(await service.listUsers(req.query));
});

const updateUser = asyncHandler(async (req, res) => {
  res.json({ user: await service.updateUser(req.params.userId, req.body, context(req)) });
});

// --- Audit log -----------------------------------------------------------
const listAuditLogs = asyncHandler(async (req, res) => {
  res.json(await service.listAuditLogs(req.query));
});

// --- Templates -----------------------------------------------------------
const listTemplates = asyncHandler(async (req, res) => {
  res.json({ templates: await service.listTemplates() });
});

const updateTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await service.updateTemplate(req.params.templateId, req.body, context(req)) });
});

// --- System --------------------------------------------------------------
const getSystem = asyncHandler(async (req, res) => {
  res.json({ system: await service.getSystem() });
});

module.exports = {
  getOverview,
  getWorkspace,
  setWorkspaceStatus,
  updateSubscription,
  listUsers,
  updateUser,
  listAuditLogs,
  listTemplates,
  updateTemplate,
  getSystem,
};
