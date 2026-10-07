'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const RECOVERY_STATUSES = ['not_contacted', 'contacted', 'recovered', 'lost'];

// One arrival's UTM values, click ids and referrer (storefront lib/touches.ts); nothing personal.
const touchText = Joi.string().trim().max(500).allow('');
const touch = Joi.object({
  source: touchText, medium: touchText, campaign: touchText, content: touchText, term: touchText, adId: touchText,
  fbclid: touchText, ttclid: touchText, gclid: touchText, scCid: touchText, ref: touchText, referrer: touchText,
  landingPage: touchText, at: touchText,
  // The other platforms' click ids (marketing/adClickIds.js, item 254).
  twclid: touchText, rdt_cid: touchText, msclkid: touchText, tblci: touchText,
});

module.exports = {
  // Public storefront autosave. Prices are never accepted: every line is
  // priced from the catalogue server-side.
  capture: {
    params: Joi.object({ workspaceId: workspaceRef().required() }),
    body: Joi.object({
      // Captured from a name alone, or a valid number (SPEC §6.2): one of the two.
      contact: Joi.object({
        fullName: Joi.string().max(200).allow(null, '').optional(),
        phone: Joi.string().max(32).allow(null, '').optional(),
        email: joiEmail().allow(null, '').optional(),
      })
        .or('phone', 'fullName')
        .required(),
      items: Joi.array()
        .items(
          Joi.object({
            variantId: uuid.required(),
            offerId: uuid.optional(),
            quantity: Joi.number().integer().min(1).max(100).required(),
          })
        )
        .min(1)
        .max(20)
        .required(),
      source: Joi.string().valid('store', 'funnel').default('store'),
      visitorId: Joi.string().min(8).max(64).required(),
      // How the shopper reached the store (storefront lib/touches.ts: first and last touch, SPEC §13.4),
      // kept on the lost order (SPEC §6.1 attribution) and passed to the order it becomes.
      attribution: Joi.object({ first: touch, last: touch }).optional(),
      // The bot guard's fields (autosaveGuard.js), taken off before the save.
      website: Joi.string().max(500).allow('').optional(),
      botToken: Joi.string().max(500).optional(),
    }),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      view: Joi.string().valid('abandoned', 'converted', 'all').default('abandoned'),
      recoveryStatus: Joi.string().valid(...RECOVERY_STATUSES).optional(),
      limit: Joi.number().integer().min(1).max(100).default(30),
      before: uuid.optional(),
    }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), sessionId: uuid.required() }),
    body: Joi.object({ recoveryStatus: Joi.string().valid(...RECOVERY_STATUSES).required() }),
  },
};
