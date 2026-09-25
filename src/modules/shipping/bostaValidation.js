'use strict';
const Joi = require('joi');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };

module.exports = {
  getIntegration: { params: Joi.object(ws) },
  connect: {
    params: Joi.object(ws),
    body: Joi.object({
      apiKey: Joi.string().min(20).max(2000).required(),
      businessLocationId: Joi.string().max(100).allow(null, '').optional(),
    }),
  },
  disconnect: { params: Joi.object(ws) },

  // Public webhook: no HMAC to check in the body (Bosta doesn't sign
  // callbacks) — the shared secret arrives as the Authorization header
  // instead (checked in bostaService#verifyWebhookAuth), so the body is read
  // as-is and not schema-validated here (same approach as paymob's webhook).
  webhook: { params: Joi.object(ws) },
};
