'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
// Commerce events the storefront tracker emits; any other name is a custom
// event (Umami event_type 2). Names that start with a spreadsheet formula
// trigger are rejected so analytics exports can't carry CSV injection.
const EVENT_NAMES = ['page_view', 'view_content', 'add_to_cart', 'begin_checkout', 'purchase'];
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const safeString = (max) => Joi.string().max(max).pattern(FORMULA_TRIGGER_RE, { invert: true });
// `metadata` / `data` are opaque; the service drops them when they serialise past 2KB.
const metadata = Joi.object().unknown(true);

const event = Joi.object({
  name: safeString(100).required(),
  path: Joi.string().max(500).optional(),
  url: Joi.string().max(2000).optional(), // full href or a path
  title: Joi.string().max(500).optional(),
  referrer: Joi.string().max(500).allow('').optional(), // a path when same-origin
  tag: safeString(50).optional(),
  currency: Joi.string().length(3).uppercase().optional(),
  data: metadata.optional(),
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
      screen: Joi.string().max(11).pattern(/^\d{1,5}x\d{1,5}$/).optional(),
      language: Joi.string().max(35).optional(),
      hostname: Joi.string().max(100).optional(),
      attribution: attribution.optional(),
      events: Joi.array().items(event).min(1).max(20).required(),
    }),
  },
};
