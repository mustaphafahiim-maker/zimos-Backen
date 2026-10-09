'use strict';

const Joi = require('joi');
const { EVENT_NAMES, WILDCARD } = require('./webhookEvents');

const uuid = Joi.string().uuid();
const workspaceParam = { workspaceId: uuid.required() };
const endpointParams = Joi.object({ ...workspaceParam, endpointId: uuid.required() });

// Only the shape here; webhookUrlGuard.checkUrl decides whether the address
// is one we may send to, and says why not.
const url = Joi.string().trim().max(500);
const events = Joi.array()
  .items(Joi.string().valid(...EVENT_NAMES, WILDCARD))
  .min(1);

// Only events about these funnels / products (webhookFilter.js); null clears it.
const filter = Joi.object({
  funnelIds: Joi.array().items(uuid).max(50).default([]),
  productIds: Joi.array().items(uuid).max(50).default([]),
}).allow(null);

module.exports = {
  list: { params: Joi.object(workspaceParam) },
  create: {
    params: Joi.object(workspaceParam),
    body: Joi.object({ url: url.required(), events: events.required(), isActive: Joi.boolean().optional(), filter: filter.optional(), customHeaders: require('./customHeaders').schema.optional() }),
  },
  update: {
    params: endpointParams,
    body: Joi.object({ url: url.optional(), events: events.optional(), isActive: Joi.boolean().optional(), filter: filter.optional(), customHeaders: require('./customHeaders').schema.optional() }).min(1),
  },
  byId: { params: endpointParams },
  deliveries: {
    params: endpointParams,
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(200).default(50),
      status: Joi.string().valid('pending', 'delivered', 'failed', 'exhausted').optional(),
    }),
  },
  redeliver: { params: Joi.object({ ...workspaceParam, endpointId: uuid.required(), deliveryId: uuid.required() }) },
};
