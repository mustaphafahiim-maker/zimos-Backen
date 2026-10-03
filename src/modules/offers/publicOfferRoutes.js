'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const rules = require('./offerRules');

/*
 * Offer rules, shopper side — mounted inside the public store router
 * (/api/v1/store/:workspaceId, after resolvePublicWorkspace):
 *
 *   GET  /products/:productId/bumps        the product's order bumps (≤ 3)
 *   GET  /cross-sell?productIds=&placement=  what to suggest beside these products
 *   GET  /orders/:orderId/upsell?number=   the thank-you page's offer, or null
 *   POST /orders/:orderId/upsell           { number, offerId } → adds it to the order
 *   GET  /exit-downsell                    the exit popup, or null
 */

const router = Router({ mergeParams: true });
const uuid = Joi.string().uuid();
const workspaceId = workspaceRef().required();
const ws = (req) => req.tenant.workspaceId;

router.get(
  '/products/:productId/bumps',
  validate({ params: Joi.object({ workspaceId, productId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json({ bumps: await rules.publicBumpsForProduct(ws(req), req.params.productId) }))
);

router.get(
  '/cross-sell',
  validate({
    params: Joi.object({ workspaceId }),
    query: Joi.object({
      // Comma-separated product ids: what is in the cart or the order.
      productIds: Joi.string().max(2000).required(),
      placement: Joi.string()
        .valid(...rules.PLACEMENTS)
        .default('cart'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const productIds = [...new Set(String(req.query.productIds).split(',').map((id) => id.trim()))].filter((id) => isUuid.test(id)).slice(0, 50);
    res.json(await rules.suggestCrossSell(ws(req), productIds, req.query.placement));
  })
);

const orderParams = Joi.object({ workspaceId, orderId: uuid.required() });

router.get(
  '/orders/:orderId/upsell',
  validate({ params: orderParams, query: Joi.object({ number: Joi.string().trim().max(40).required() }) }),
  asyncHandler(async (req, res) => res.json({ upsell: await rules.publicUpsell(ws(req), req.params.orderId, req.query.number) }))
);

router.post(
  '/orders/:orderId/upsell',
  validate({ params: orderParams, body: Joi.object({ number: Joi.string().trim().max(40).required(), offerId: uuid.required() }) }),
  // No Idempotency-Key needed: one acceptance per order is enforced by a unique index.
  asyncHandler(async (req, res) =>
    res.status(201).json({ order: await rules.acceptUpsell(ws(req), req.params.orderId, req.body.number, req.body.offerId) })
  )
);

router.get(
  '/exit-downsell',
  validate({ params: Joi.object({ workspaceId }) }),
  asyncHandler(async (req, res) => res.json({ exitDownsell: await rules.publicExitDownsell(req.publicWorkspace) }))
);

// What a coupon would take off these items (discounts/couponExtras.js): the code box and ?coupon= links.
router.post(
  '/coupon-preview',
  validate({
    params: Joi.object({ workspaceId }),
    body: Joi.object({
      code: Joi.string().trim().min(1).max(100).required(),
      items: Joi.array()
        .items(Joi.object({ variantId: uuid.required(), offerId: uuid.optional(), quantity: Joi.number().integer().min(1).max(1000).default(1) }))
        .min(1)
        .max(50)
        .required(),
    }),
  }),
  asyncHandler(async (req, res) =>
    res.json({ coupon: await require('../discounts/couponExtras').previewCode(ws(req), req.body.code, req.body.items) })
  )
);

module.exports = router;
