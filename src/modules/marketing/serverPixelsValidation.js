'use strict';
const Joi = require('joi');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
// A merchant-pasted access token/secret — generous length cap only, each
// platform's own token format is opaque to us (same treatment as Paymob's
// apiKey / Bosta's apiKey).
const token = Joi.string().min(8).max(4000);

module.exports = {
  getIntegration: { params: Joi.object(ws) },
  connect: {
    params: Joi.object(ws),
    body: Joi.object({
      metaAccessToken: token.allow('').optional(),
      metaTestEventCode: token.allow('').optional(),
      tiktokAccessToken: token.allow('').optional(),
      snapchatAccessToken: token.allow('').optional(),
      googleApiSecret: token.allow('').optional(),
    }).min(1),
  },
  disconnect: { params: Joi.object(ws) },
};
