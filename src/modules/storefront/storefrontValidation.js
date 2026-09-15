'use strict';
const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const workspaceIdParam = workspaceRef().required();

module.exports = {
  listProducts: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({
      collectionId: uuid.optional(),
      tag: Joi.string().max(100).optional(),
      search: Joi.string().max(200).optional(),
      limit: Joi.number().integer().min(1).max(100).default(24),
      cursor: uuid.optional(),
    }),
  },
  getProduct: {
    params: Joi.object({ workspaceId: workspaceIdParam, idOrSlug: Joi.string().max(300).required() }),
  },
  workspaceParam: { params: Joi.object({ workspaceId: workspaceIdParam }) },
  getCollection: { params: Joi.object({ workspaceId: workspaceIdParam, collectionId: uuid.required() }) },
  lookupOrder: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    body: Joi.object({
      orderNumber: Joi.string().max(60).optional(),
      orderId: uuid.optional(),
      phone: Joi.string().min(6).max(32).required(),
    }).or('orderNumber', 'orderId'),
  },
  quoteShipping: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({
      country: Joi.string().length(2).uppercase().default('EG'),
      region: Joi.string().max(100).allow('').optional(),
      subtotal: Joi.number().integer().min(0).default(0),
      quantity: Joi.number().integer().min(1).max(1000).default(1),
      weightGrams: Joi.number().integer().min(0).default(0),
    }),
  },
};
