'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./confirmationService');

const listQueue = asyncHandler(async (req, res) => res.json(await service.listQueue(req.tenant.workspaceId, req.query, req)));
const counts = asyncHandler(async (req, res) => res.json({ counts: await service.queueCounts(req.tenant.workspaceId, req) }));
const assignees = asyncHandler(async (req, res) => res.json({ assignees: await service.listAssignees(req.tenant.workspaceId) }));
const assign = asyncHandler(async (req, res) =>
  res.json({ task: await service.assignTask(req.tenant.workspaceId, req.params.taskId, req.body.userId, req) })
);
const unassign = asyncHandler(async (req, res) =>
  res.json({ task: await service.assignTask(req.tenant.workspaceId, req.params.taskId, null, req) })
);
const assignMany = asyncHandler(async (req, res) => res.json(await service.assignTasks(req.tenant.workspaceId, req.body, req)));
const claim = asyncHandler(async (req, res) => res.json({ task: await service.claimTask(req.tenant.workspaceId, req.params.taskId, req) }));
const release = asyncHandler(async (req, res) => res.json({ task: await service.releaseTask(req.tenant.workspaceId, req.params.taskId, req) }));
const outcome = asyncHandler(async (req, res) => res.json({ task: await service.recordOutcome(req.tenant.workspaceId, req.params.taskId, req.body, req) }));
const correction = asyncHandler(async (req, res) => res.json({ task: await service.correctOutcome(req.tenant.workspaceId, req.params.taskId, req.body, req) }));

module.exports = { listQueue, counts, assignees, assign, unassign, assignMany, claim, release, outcome, correction };
