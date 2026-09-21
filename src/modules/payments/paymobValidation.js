'use strict';
const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const paymobId = Joi.alternatives().try(Joi.number().integer().min(1), Joi.string().pattern(/^\d{1,20}$/));

module.exports = {
  getIntegration: { params: Joi.object(ws) },
  connect: {
    params: Joi.object(ws),
    body: Joi.object({
      apiKey: Joi.string().min(20).max(2000).required(),
      // Required on first connect (enforced in the service); blank on a
      // reconnect keeps the stored one.
      hmacSecret: Joi.string().min(8).max(200).allow('', null).optional(),
      cardIntegrationId: paymobId.allow(null, '').optional(),
      iframeId: paymobId.allow(null, '').optional(),
      walletIntegrationId: paymobId.allow(null, '').optional(),
    })
      .or('cardIntegrationId', 'walletIntegrationId')
      .with('cardIntegrationId', 'iframeId'),
  },
  disconnect: { params: Joi.object(ws) },

  // Public storefront
  paymentOptions: { params: Joi.object({ workspaceId: workspaceRef().required() }) },
  pay: { params: Joi.object({ workspaceId: workspaceRef().required(), orderId: uuid.required() }) },

  // Public webhook: HMAC arrives as ?hmac=; the body is read as-is (not validated,
  // so nothing Paymob signed is stripped).
  webhook: { params: Joi.object(ws), query: Joi.object({ hmac: Joi.string().max(256).allow('') }).unknown(true) },
};
