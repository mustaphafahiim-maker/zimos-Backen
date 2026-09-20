'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();

const workspaceParams = Joi.object({ workspaceId: uuid.required() });

module.exports = {
  workspaceDetail: { params: workspaceParams },

  setWorkspaceStatus: {
    params: workspaceParams,
    body: Joi.object({
      status: Joi.string().valid('active', 'suspended', 'closed').required(),
      // Free-text note kept on the audit entry, not on the workspace row.
      reason: Joi.string().max(300).allow('', null),
    }),
  },

  updateSubscription: {
    params: workspaceParams,
    // A partial edit — only the fields an operator actually changed are sent.
    body: Joi.object({
      status: Joi.string().valid('trialing', 'active', 'past_due', 'suspended', 'cancelled'),
      planId: uuid,
      billingCycle: Joi.string().valid('monthly', 'yearly'),
      trialEndsAt: Joi.date().iso().allow(null),
      currentPeriodEnd: Joi.date().iso(),
      graceUntil: Joi.date().iso().allow(null),
      cancelAtPeriodEnd: Joi.boolean(),
    }).min(1),
  },

  listUsers: {
    query: Joi.object({
      search: Joi.string().max(200).allow(''),
      limit: Joi.number().integer().min(1).max(100).default(50),
      // Keyset pagination on createdAt, newest first.
      before: Joi.date().iso(),
    }),
  },

  updateUser: {
    params: Joi.object({ userId: uuid.required() }),
    // `status` is checked against the enum's real values in the service, so a
    // schema change to users.status can't silently drift from this list.
    body: Joi.object({ status: Joi.string().max(30), platformAdmin: Joi.boolean() }).min(1),
  },

  listAuditLogs: {
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      before: Joi.date().iso(),
      workspaceId: uuid,
      // Prefix match, e.g. "admin." for every platform-admin action.
      action: Joi.string().max(100),
      entityType: Joi.string().max(100),
    }),
  },

  updateTemplate: {
    params: Joi.object({ templateId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().min(2).max(200),
      category: Joi.string().max(100).allow(null, ''),
      thumbnailUrl: Joi.string().uri().max(500).allow(null, ''),
      isPublished: Joi.boolean(),
    }).min(1),
  },
};
