'use strict';

const Joi = require('joi');
const { REASON_CODES } = require('./returnService');

const uuid = Joi.string().uuid();

const line = Joi.object({
  orderItemId: uuid.required(),
  quantity: Joi.number().integer().min(1).required(),
  // An exchange (item 372): the variant of the same product to send instead.
  exchangeVariantId: uuid.allow(null).optional(),
});

module.exports = {
  create: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      reasonCode: Joi.string().valid(...REASON_CODES).required(),
      reasonDetail: Joi.string().max(280).allow('', null).optional(),
      items: Joi.array().items(line).min(1).required(),
      resolution: Joi.string().valid('refund', 'exchange').default('refund'),
    }),
  },
  listForOrder: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      status: Joi.string().valid('requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled').optional(),
    }),
  },
  moderate: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
    body: Joi.object({
      action: Joi.string().valid('approve', 'reject').required(),
      // Item 372: told to the shopper with the decision.
      note: Joi.string().trim().max(500).allow('', null),
      // false keeps the decision from the shopper, true sends the email even while its template is off;
      // left out, the store's return_approved / return_rejected switch decides.
      notifyCustomer: Joi.boolean().optional(),
      // What the replacement order of an exchange charges for shipping (minor units; none by default).
      exchangeShippingAmount: Joi.number().integer().min(0).max(100000000).default(0),
    }),
  },
  restock: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
  },
  pickup: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
    body: Joi.object({
      carrierCode: Joi.string().max(50).required(),
      // A carrier connected here books it; 'manual' records a pickup booked elsewhere with its waybill.
      waybillNumber: Joi.string().trim().max(100).when('carrierCode', { is: 'manual', then: Joi.required(), otherwise: Joi.forbidden() }),
      // The courier's own ids for the pickup address, as for a booking (orderValidation createShipment).
      carrierAddress: Joi.object({
        names: Joi.array().items(Joi.string().trim().max(100).allow('')).min(1).max(6).optional(),
        path: Joi.array().items(Joi.string().max(100)).min(1).max(6).when('names', { is: Joi.exist(), then: Joi.forbidden(), otherwise: Joi.optional() }),
        cityId: Joi.string().max(100),
        districtId: Joi.string().max(100),
      }).and('cityId', 'districtId').oxor('path', 'cityId').oxor('names', 'cityId').optional(),
      notes: Joi.string().trim().max(500).allow('', null),
    }),
  },
  // Item 396.
  cancelPickup: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
    body: Joi.object({
      // The courier cannot be asked (no cancel API, or disconnected): the merchant cancelled it there.
      acknowledgeManualCancel: Joi.boolean().optional(),
    }).optional(),
  },
  cancel: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
    body: Joi.object({
      note: Joi.string().trim().max(500).allow('', null),
      acknowledgeManualCancel: Joi.boolean().optional(),
    }).optional(),
  },
};
