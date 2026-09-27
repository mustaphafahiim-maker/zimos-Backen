'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const EVENT_NAMES = ['page_view', 'view_content', 'add_to_cart', 'begin_checkout', 'purchase'];
// `metadata` is opaque; the service drops it when it serialises past 2KB.
const metadata = Joi.object().unknown(true);

const event = Joi.object({
  name: Joi.string().valid(...EVENT_NAMES).required(),
  path: Joi.string().max(500).optional(),
  websiteId: uuid.optional(),
  funnelId: uuid.optional(),
  orderId: uuid.optional(),
  revenueAmount: Joi.number().integer().min(0).optional(),
  dedupeId: Joi.string().max(100).optional(),
  occurredAt: Joi.date().iso().optional(),
  metadata: metadata.optional(),
});

const attribution = Joi.object({
  source: Joi.string().max(100).optional(),
  medium: Joi.string().max(100).optional(),
  campaign: Joi.string().max(150).optional(),
  referrer: Joi.string().max(500).optional(),
  landingPage: Joi.string().max(500).optional(),
  clickIds: Joi.object({
    gclid: Joi.string().max(200).optional(),
    fbclid: Joi.string().max(200).optional(),
    ttclid: Joi.string().max(200).optional(),
  }).optional(),
});

module.exports = {
  EVENT_NAMES,
  ingest: {
    params: Joi.object({ workspaceId: workspaceRef().required() }),
    body: Joi.object({
      visitorId: Joi.string().min(8).max(64).required(),
      sessionId: Joi.string().min(8).max(64).required(),
      attribution: attribution.optional(),
      events: Joi.array().items(event).min(1).max(20).required(),
    }),
  },
};
