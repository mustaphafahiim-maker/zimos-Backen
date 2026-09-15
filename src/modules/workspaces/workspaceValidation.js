'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { ALL_PERMISSIONS } = require('../../core/security/permissions');
const { workspaceSlug, SLUG_LOOKUP_MAX } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();

module.exports = {
  create: { body: Joi.object({ name: Joi.string().min(2).max(200).required() }) },
  // Only the length is policed here: every other rule comes back as a `reason`
  // in a 200 response instead of a validation error, so the merchant UI can
  // explain what is wrong with an address as it is typed.
  checkSlug: {
    query: Joi.object({ slug: Joi.string().trim().min(1).max(SLUG_LOOKUP_MAX).required() }),
  },
  updateWorkspace: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().min(2).max(200).optional(),
      // The store's public address (<slug>.PLATFORM_ROOT_DOMAIN). A reserved
      // or malformed value is refused here as 422; one another workspace
      // already holds comes back from the service as 409.
      slug: workspaceSlug().optional(),
      logoUrl: Joi.string().uri().allow('', null).max(1000).optional(),
      tagline: Joi.string().allow('', null).max(300).optional(),
      // Opaque theme blob; light key cap here, ~5KB size cap in the service.
      themeSettings: Joi.object().unknown(true).max(50).optional(),
      // Merchant-tunable store settings merged into workspaces.settings JSONB.
      // Amounts are integer minor currency units (piastres/cents), the same
      // convention as every amount column. `null` clears a value back to
      // "not configured"; unknown keys are stripped by the validate middleware.
      settings: Joi.object({
        free_shipping_threshold_amount: Joi.number().integer().min(0).allow(null).optional(),
        default_shipping_rate_amount: Joi.number().integer().min(0).allow(null).optional(),
        tax_enabled: Joi.boolean().optional(),
        // Browser ad pixels loaded on the public store. IDs only (no secrets).
        tracking_pixels: Joi.object({
          meta: Joi.string().pattern(/^\d{5,20}$/).allow(null, '').optional(),
          tiktok: Joi.string().pattern(/^[A-Z0-9]{10,30}$/).allow(null, '').optional(),
          snapchat: Joi.string().pattern(/^[a-f0-9-]{20,40}$/i).allow(null, '').optional(),
          google_tag: Joi.string().pattern(/^(G|AW|GT)-[A-Z0-9]{4,20}$/).allow(null, '').optional(),
        }).allow(null).optional(),
        // Fraud rules enforced on public storefront orders (orderService).
        fraud_rules: Joi.object({
          action: Joi.string().valid('flag', 'block').default('flag'),
          block_blacklisted: Joi.boolean().default(false),
          duplicate_window_minutes: Joi.number().integer().min(1).max(10080).allow(null).optional(),
          max_orders_per_phone_per_day: Joi.number().integer().min(1).max(100).allow(null).optional(),
          high_rejection_threshold: Joi.number().integer().min(1).max(100).allow(null).optional(),
        }).allow(null).optional(),
        // Public checkout form behaviour (storefront + checkout controller).
        checkout_settings: Joi.object({
          email: Joi.string().valid('hidden', 'optional', 'required').default('optional'),
          alternate_phone: Joi.string().valid('hidden', 'optional', 'required').default('optional'),
          notes: Joi.string().valid('hidden', 'optional', 'required').default('optional'),
          allow_discount_codes: Joi.boolean().default(true),
          thank_you_message: Joi.string().max(300).allow('', null).optional(),
        }).allow(null).optional(),
      }).optional(),
    }).min(1),
  },
  invite: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ email: joiEmail().required(), roleId: uuid.required() }),
  },
  listMembers: { params: Joi.object({ workspaceId: uuid.required() }) },
  resendInvite: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
  },
  updateRole: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
    body: Joi.object({ roleId: uuid.required() }),
  },
  removeMember: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
  },
  createRole: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().min(2).max(100).required(),
      key: Joi.string().min(2).max(64).pattern(/^[a-z0-9_]+$/).required(),
      permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).min(1).required(),
    }),
  },
};
