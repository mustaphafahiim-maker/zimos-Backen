'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { customizationsInputSchema } = require('../catalog/customFields');
const { formFieldsBodySchema } = require('./checkoutForm');

const contact = Joi.object({
  fullName: Joi.string().max(200).required(),
  phone: Joi.string().max(32).required(),
  alternatePhone: Joi.string().max(32).allow(null, '').optional(),
  email: joiEmail().allow(null, '').optional(),
});

const address = Joi.object({
  country: Joi.string().length(2).required(),
  province: Joi.string().max(100).allow(null, '').optional(),
  // Required unless the store's purchase form switched them off — enforced
  // per store in checkoutForm.assertCheckoutForm.
  city: Joi.string().max(100).allow(null, '').optional(),
  addressLine: Joi.string().max(500).allow(null, '').optional(),
  postalCode: Joi.string().max(20).allow(null, '').optional(),
  notes: Joi.string().max(500).allow(null, '').optional(),
});

const uuid = Joi.string().uuid();
const workspaceIdParam = workspaceRef().required();

module.exports = {
  checkout: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    body: Joi.object({
      contact: contact.required(),
      shippingAddress: address.optional(),
      // 'card' / 'wallet' go through the store's connected gateway and are
      // refused unless PAYMENTS_ONLINE_ENABLED is on (see checkoutController):
      // with it off the checkout takes cash on delivery only, as it always
      // has. Staff order creation (orders/orderValidation.js) accepts every
      // method — a merchant recording a bank transfer they received is real.
      paymentMethod: Joi.string().valid('cod', 'card', 'wallet').required(),
      // Which gateway, when more than one offers the method. Optional.
      paymentProvider: Joi.string().max(50).optional(),
      // Where the gateway sends the shopper back to (online methods only).
      returnUrl: Joi.string().max(2000).optional(),
      discountCode: Joi.string().max(100).optional(),
      funnelId: uuid.optional(),
      websiteId: uuid.optional(),
      notes: Joi.string().max(2000).allow('').optional(),
      // The autosaved session (POST /checkout-sessions) this checkout came
      // from, converted once the order exists. Sessions with the same phone
      // are converted either way; this covers a changed phone. Deliberately
      // loose: it is a hint, and a malformed one must never cost the shopper
      // their order — the conversion step ignores anything it cannot use.
      checkoutSessionId: Joi.string().max(100).allow('', null).optional(),
      // "Buy Now" — a single item straight to checkout, no cart. Ignored when
      // an X-Cart-Token header is present (the cart wins).
      item: Joi.object({
        variantId: uuid.required(),
        offerId: uuid.optional(),
        quantity: Joi.number().integer().min(1).default(1),
        // Answers to the product's custom fields (see cartValidation.addItem).
        customizations: customizationsInputSchema.optional(),
      }).optional(),
      // More "Buy Now" lines beside `item`: a quantity bundle with a variant
      // chosen per unit (one red, one blue). Priced by the server like `item`.
      extraItems: Joi.array()
        .items(
          Joi.object({
            variantId: uuid.required(),
            offerId: uuid.optional(),
            quantity: Joi.number().integer().min(1).default(1),
            customizations: customizationsInputSchema.optional(),
          })
        )
        .max(20)
        .optional(),
      // The shopper ticked the order bump. Only the offer is named: the server
      // accepts it only when it is the bump this checkout offers (the store's,
      // or the funnel checkout step's) and prices the line itself
      // (checkout/orderBump.js).
      orderBump: Joi.object({ offerId: uuid.required() }).optional(),
      // The bot guard's fields (risk/botProtection): the honeypot, the time
      // token from GET /checkout/guard, the challenge token. Deliberately
      // loose — the guard decides, and takes them off the body.
      website: Joi.string().max(500).allow('', null).optional(),
      botToken: Joi.string().max(500).allow('', null).optional(),
      captchaToken: Joi.string().max(4000).allow('', null).optional(),
      // Answers to the purchase-form fields with no column of their own
      // (sa_national_address, custom_1…5) — checkout/checkoutForm.js.
      formFields: formFieldsBodySchema,
    }),
  },
};
