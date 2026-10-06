'use strict';

const Joi = require('joi');
const { PLATFORM_NAMES, SCOPE_TYPES } = require('./trackingPixelService');
const { TIMINGS } = require('./purchaseTiming');

const uuid = Joi.string().uuid();
const workspaceParam = { workspaceId: uuid.required() };
const pixelParams = Joi.object({ ...workspaceParam, pixelId: uuid.required() });

// The ID's exact shape depends on the platform and is checked in the service
// (trackingPixelService.PLATFORMS); this only bounds it.
const pixelId = Joi.string().trim().min(4).max(64);
// A merchant-pasted access token: opaque to us, generous cap (as in
// serverPixelsValidation.js).
const token = Joi.string().trim().min(8).max(4000);
const scope = Joi.object({
  type: Joi.string().valid(...SCOPE_TYPES).required(),
  ids: Joi.array().items(uuid).max(100).default([]),
});
const config = Joi.object({
  // Google Ads conversion label ("AbC-D_efG-h12_34-567"), used with an AW- id.
  adsConversionLabel: Joi.string().trim().pattern(/^[A-Za-z0-9_-]{4,60}$/).allow(null, ''),
});

const shared = {
  label: Joi.string().trim().max(120).allow(null, ''),
  capiEnabled: Joi.boolean(),
  testEventCode: Joi.string().trim().max(100).allow(null, ''),
  scope,
  config,
  isActive: Joi.boolean(),
};

module.exports = {
  list: { params: Joi.object(workspaceParam) },
  updateSettings: {
    params: Joi.object(workspaceParam),
    // conversionEvent: report orders as Purchase or Lead (conversionEvent.js).
    body: Joi.object({ purchaseEventTiming: Joi.string().valid(...TIMINGS).optional(), conversionEvent: Joi.string().valid(...require('./conversionEvent').KINDS).optional() }).min(1),
  },
  events: {
    params: Joi.object(workspaceParam),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      cursor: Joi.date().iso(),
      status: Joi.string().valid('sent', 'failed'),
      trackingPixelId: uuid,
    }),
  },
  create: {
    params: Joi.object(workspaceParam),
    body: Joi.object({
      platform: Joi.string().valid(...PLATFORM_NAMES).required(),
      pixelId: pixelId.required(),
      capiToken: token,
      ...shared,
    }),
  },
  update: {
    params: pixelParams,
    // capiToken '' removes the stored token; leaving it out keeps it.
    body: Joi.object({ pixelId, capiToken: token.allow(''), ...shared }).min(1),
  },
  remove: { params: pixelParams },
};
