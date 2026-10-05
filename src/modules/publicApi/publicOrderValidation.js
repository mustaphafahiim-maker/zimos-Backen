'use strict';

const Joi = require('joi');
const orderSchemas = require('../orders/orderValidation');

/**
 * The public routes take the dashboard's own request bodies and list query
 * (orders/orderValidation.js) wherever the operation is the same, so the two
 * can never accept different things. Only the params differ: the workspace
 * comes from the API key, never the URL.
 */

const uuid = Joi.string().uuid();
const orderParam = Joi.object({ orderId: uuid.required() });

module.exports = {
  list: { query: orderSchemas.list.query },
  get: { params: orderParam },
  byNumber: { params: Joi.object({ orderNumber: Joi.string().trim().min(1).max(41).required() }) },
  confirmation: {
    params: orderParam,
    body: Joi.object({
      outcome: Joi.string().valid('confirmed', 'rejected', 'unreachable', 'postponed').required(),
      // Why it was rejected, or why a final outcome is being changed.
      reason: Joi.string().trim().min(1).max(300).when('outcome', { is: 'rejected', then: Joi.required() }),
      notes: Joi.string().max(600).allow('').optional(),
      // Changing a confirmed order to rejected cancels its courier booking;
      // for a courier with no cancel API, confirm it was cancelled there.
      acknowledgeManualCancel: Joi.boolean().optional(),
    }),
  },
  cancel: { params: orderParam, body: orderSchemas.cancel.body },
  createShipment: { params: orderParam, body: orderSchemas.createShipment.body },
  updateShipment: {
    params: Joi.object({ orderId: uuid.required(), shipmentId: uuid.required() }),
    body: orderSchemas.updateShipment.body,
  },
};
