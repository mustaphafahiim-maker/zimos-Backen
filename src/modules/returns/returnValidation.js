'use strict';

const Joi = require('joi');
const { REASON_CODES } = require('./returnService');

const uuid = Joi.string().uuid();

const line = Joi.object({
  orderItemId: uuid.required(),
  quantity: Joi.number().integer().min(1).required(),
  // An exchange (returnExchange.js): the variant of the same product to send instead.
  exchangeVariantId: uuid.allow(null).optional(),
});

module.exports = {
  create: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      reasonCode: Joi.string().valid(...REASON_CODES).required(),
      reasonDetail: Joi.string().max(280).allow('', null).optional(),
      items: Joi.array().items(line).min(1).required(),
      // 'exchange' only while STORE_FEATURES has return_exchanges; otherwise a refund, as before.
      resolution: Joi.string().valid('refund', 'exchange').default('refund'),
    }),
  },
  listForOrder: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      status: Joi.string().valid('requested', 'approved', 'rejected', 'received', 'refunded').optional(),
    }),
  },
  moderate: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
    body: Joi.object({
      action: Joi.string().valid('approve', 'reject').required(),
      // Told to the shopper with the decision.
      note: Joi.string().trim().max(500).allow('', null),
      // Kept on the audit and the event: false keeps the decision from the shopper.
      notifyCustomer: Joi.boolean().optional(),
      // What the replacement order of an exchange charges for shipping (minor units; none by default).
      exchangeShippingAmount: Joi.number().integer().min(0).max(100000000).default(0),
    }),
  },
  restock: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
  },
};
