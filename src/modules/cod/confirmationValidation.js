'use strict';
const Joi = require('joi');
const { QUEUE_SORT_KEYS, QUEUE_DEFAULT_SORT } = require('../orders/orderSort');

const uuid = Joi.string().uuid();
const taskParams = Joi.object({ workspaceId: uuid.required(), taskId: uuid.required() });

// How the customer was reached. A plain string checked here rather than an
// ENUM column, so a new channel needs no migration.
const CHANNELS = ['call', 'whatsapp', 'other'];
const channel = Joi.string().valid(...CHANNELS);
// A callback time the customer gave: in the future, at most 60 days ahead.
const CALLBACK_MAX_DAYS = 60;
const callbackAt = Joi.date()
  .iso()
  .greater('now')
  .custom((value, helpers) => (value.getTime() > Date.now() + CALLBACK_MAX_DAYS * 864e5 ? helpers.message(`"callbackAt" must be within ${CALLBACK_MAX_DAYS} days`) : value));

module.exports = {
  // Shared with the order page's "needs follow-up" move (orders/orderValidation.js).
  callbackAt,
  CHANNELS,
  channel,
  listQueue: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      // `queued` is the old name of `pending`, kept for clients that predate the tabs.
      status: Joi.string().valid('pending', 'queued', 'in_progress', 'done').default('pending'),
      mine: Joi.boolean().default(false),
      // 'me', 'unassigned', or one member's user id.
      assignedTo: Joi.alternatives().try(Joi.string().valid('me', 'unassigned'), uuid).optional(),
      cursor: uuid.optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      // 'default' is each tab's own order; the rest sort by the task's order
      // (orders/orderSort.js). A cursor only pages the sort it came from.
      sort: Joi.string()
        .valid(...QUEUE_SORT_KEYS)
        .default(QUEUE_DEFAULT_SORT),
    }),
  },
  counts: { params: Joi.object({ workspaceId: uuid.required() }) },
  assignees: { params: Joi.object({ workspaceId: uuid.required() }) },
  assign: {
    params: taskParams,
    body: Joi.object({ userId: uuid.required() }),
  },
  unassign: { params: taskParams },
  // One assignee for many tasks; `userId: null` unassigns them all.
  assignMany: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      taskIds: Joi.array().items(uuid.required()).min(1).max(200).unique().required(),
      userId: uuid.allow(null).required(),
    }),
  },
  claim: { params: taskParams },
  release: { params: taskParams },
  outcome: {
    params: taskParams,
    body: Joi.object({
      outcome: Joi.string().valid('confirmed', 'rejected', 'unreachable', 'postponed').required(),
      notes: Joi.string().max(1000).allow('').optional(),
      rejectionReason: Joi.string().max(300).when('outcome', { is: 'rejected', then: Joi.required() }),
      channel: channel.optional(),
      // "Call me tomorrow at 5" (postponed or unreachable): the task is due again then. Future, within 60 days.
      callbackAt: callbackAt.when('outcome', { is: Joi.valid('postponed', 'unreachable'), then: Joi.optional(), otherwise: Joi.forbidden() }),
    }),
  },
  correction: {
    params: taskParams,
    body: Joi.object({
      outcome: Joi.string().valid('confirmed', 'rejected').required(),
      reason: Joi.string().trim().min(1).max(300).required(),
      notes: Joi.string().max(600).allow('').optional(),
      // Correcting to rejected cancels the order's courier booking; for a
      // courier without a cancel API the merchant confirms they did it there.
      acknowledgeManualCancel: Joi.boolean().optional(),
    }),
  },
};
