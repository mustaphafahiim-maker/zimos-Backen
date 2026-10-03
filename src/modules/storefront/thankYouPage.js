'use strict';

const Joi = require('joi');

/**
 * The store's thank-you page (SPEC §8.7), stored whole under
 * `workspaces.settings.thank_you_page` (PATCH /workspaces/:id) and read back
 * publicly from GET /store/:workspaceId as `thankYou`.
 *
 * `content` is plain text — the storefront prints it as text, one paragraph
 * per line, after replacing {{order_number}} and {{customer_name}} — so no
 * markup a merchant pastes can run on the shopper's device.
 */

const DEFAULTS = Object.freeze({
  enabled: false,
  content: '',
  show_back_home_button: true,
  show_products_from_collection_id: null,
});

const thankYouPageSchema = Joi.object({
  enabled: Joi.boolean().required(),
  content: Joi.string().trim().max(5000).allow('', null).optional(),
  show_back_home_button: Joi.boolean().optional(),
  show_products_from_collection_id: Joi.string().uuid().allow(null).optional(),
});

function resolveThankYouPage(settings) {
  const s = (settings && settings.thank_you_page) || {};
  return {
    enabled: s.enabled === true,
    content: typeof s.content === 'string' ? s.content : DEFAULTS.content,
    show_back_home_button:
      typeof s.show_back_home_button === 'boolean' ? s.show_back_home_button : DEFAULTS.show_back_home_button,
    show_products_from_collection_id: s.show_products_from_collection_id || null,
  };
}

module.exports = { thankYouPageSchema, resolveThankYouPage, THANK_YOU_PAGE_DEFAULTS: DEFAULTS };
