'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const wsParam = Joi.object({ workspaceId: uuid.required() });
const gatewayParam = Joi.object({ workspaceId: uuid.required(), code: Joi.string().max(50).required() });
const storeOrderParam = Joi.object({ workspaceId: workspaceRef().required(), orderId: uuid.required() });

module.exports = {
  workspace: { params: wsParam },
  connect: {
    params: gatewayParam,
    // The adapter validates the inside of `credentials` and `settings`.
    body: Joi.object({
      credentials: Joi.object().unknown(true).optional(),
      settings: Joi.object().unknown(true).optional(),
    }),
  },
  gateway: { params: gatewayParam },
  updateMethods: {
    params: wsParam,
    body: Joi.object({
      methods: Joi.array()
        .items(Joi.object({ id: Joi.string().max(100).required(), enabled: Joi.boolean().required() }))
        .min(1)
        .max(50)
        .required(),
    }),
  },
  storeMethods: {
    params: Joi.object({ workspaceId: workspaceRef().required() }),
    // currency: what the checkout sells in, when the storefront knows (else the funnel's or the store's).
    query: Joi.object({ funnelId: Joi.string().uuid().optional(), currency: Joi.string().trim().uppercase().pattern(/^[A-Z]{3}$/).optional() }),
  },
  shopperStatus: {
    params: storeOrderParam,
    query: Joi.object({ refresh: Joi.string().valid('0', '1', 'true', 'false').optional() }),
  },
  shopperReturn: {
    params: storeOrderParam,
    // The gateway's redirect query string, as the shopper's browser received it.
    body: Joi.object({
      query: Joi.object()
        .pattern(Joi.string().max(100), Joi.alternatives().try(Joi.string().max(2000).allow(''), Joi.number(), Joi.boolean()))
        .max(100)
        .optional(),
    }),
  },
  shopperRetry: {
    params: storeOrderParam,
    body: Joi.object({
      paymentMethod: Joi.string().valid(...require('./methodNames').ONLINE_METHODS).optional(),
      paymentProvider: Joi.string().max(50).optional(),
      returnUrl: Joi.string().max(2000).optional(),
    }),
  },
  shopperAction: { params: storeOrderParam },
  // The COD checks the switch may ask for (payments/codSwitchChecks.js): a code by phone, a deposit by transfer.
  shopperSwitchToCod: {
    params: storeOrderParam,
    body: Joi.object({
      otpCode: Joi.string().trim().pattern(/^\d{4,6}$/).optional(),
      transfer: Joi.object({
        methodId: Joi.string().max(80).required(),
        receiptUploadId: Joi.string().uuid().allow(null).optional(),
        senderReference: Joi.string().max(100).allow('', null).optional(),
      }).optional(),
    }),
  },
  webhook: {
    params: Joi.object({ code: Joi.string().max(50).required(), token: Joi.string().max(100).required() }),
  },
};
