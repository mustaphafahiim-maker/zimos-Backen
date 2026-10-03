'use strict';

const Joi = require('joi');
const { TYPE_NAMES, CHANNELS } = require('./merchantNotificationService');

const uuid = Joi.string().uuid();
const workspaceParam = { workspaceId: uuid.required() };

const channelFlags = Object.fromEntries(CHANNELS.map((channel) => [channel, Joi.boolean()]));

module.exports = {
  workspaceOnly: { params: Joi.object(workspaceParam) },
  list: {
    params: Joi.object(workspaceParam),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(20),
      cursor: Joi.date().iso(),
      unread: Joi.boolean().default(false),
    }),
  },
  markRead: { params: Joi.object({ ...workspaceParam, notificationId: uuid.required() }) },
  updatePreferences: {
    params: Joi.object(workspaceParam),
    body: Joi.object({
      soundEnabled: Joi.boolean(),
      types: Joi.array()
        .items(Joi.object({ type: Joi.string().valid(...TYPE_NAMES).required(), ...channelFlags }))
        .max(TYPE_NAMES.length),
    }).min(1),
  },
};
