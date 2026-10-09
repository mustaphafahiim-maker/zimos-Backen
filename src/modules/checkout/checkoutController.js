'use strict';
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const cartService = require('../cart/cartService');
const orderService = require('../orders/orderService');
const { afterOrderCompleted } = require('../orders/orderCompletion');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { assertRequiredCheckoutFields } = require('./checkoutSettings');
const { saveCheckoutAnswers } = require('./checkoutForm');
const methodsService = require('../payments/paymentMethodsService');
const { readVisitorId } = require('../customerUploads/customerUploadService');
const online = require('../payments/onlinePaymentService');
const manualPayments = require('../manualPayments/manualPaymentService');
const { resolveOrderBumpItem } = require('./orderBump');
const { offerWindowEnd } = require('../funnels/funnelOfferMerge');
const productTests = require('../catalog/productTests');
const logger = require('../../core/utils/logger');
// The checkout answer leaves out what the store knows about the phone or visitor (risk, IP, cost).
const { shopperOrder } = require('./shopperOrder');

/** Credits the order to the shopper's variant in its products' A/B tests; never fails the checkout. */
async function creditProductTests(workspaceId, orderItems, visitorId, orderId) {
  if (!visitorId) return;
  try {
    await productTests.recordOrder(workspaceId, (orderItems || []).map((i) => i.productId).filter(Boolean), visitorId, orderId);
  } catch (err) {
    logger.warn('Product test order could not be recorded', { error: err.message });
  }
}

/**
 * Guest checkout (no login). Runs the same orderService.createOrder as the
 * staff API. Two ways in: an `X-Cart-Token` header builds the order from that
 * cart's lines, or — with no token — a single `item` in the body ("Buy now")
 * goes straight to an order with no cart. The cart wins if both are given.
 *
 * Cash on delivery places the order as a sale at once (201 { order }).
 *
 * 'card' / 'wallet' (only with PAYMENTS_ONLINE_ENABLED) place it unpaid and
 * start a payment with the store's gateway: 201 { order, payment,
 * paymentToken }. `payment.redirectUrl` is where to send the shopper;
 * `paymentToken` is shown once and is what the shopper's browser uses for the
 * status / retry / switch-to-COD endpoints. A gateway that could not start the
 * payment still answers 201 with payment.status 'failed', so the shopper can
 * retry or switch to cash on delivery on the order that now exists.
 */
const checkout = asyncHandler(async (req, res) => {
  const cartToken = req.headers['x-cart-token'];
  const { item, extraItems, orderBumps, checkoutSessionId, paymentProvider, returnUrl, orderBump, formFields, manualPaymentMethodId, ...orderBody } = req.body;
  const workspace = req.publicWorkspace;
  const workspaceId = req.tenant.workspaceId;

  // Per-store required fields (settings.checkout_settings). Checked before any
  // cart work so a rejected checkout costs nothing.
  // A pickup order has no address, so the form's address rules do not apply to it.
  assertRequiredCheckoutFields(workspace, req.body.deliveryMethod === 'pickup' ? { ...req.body, shippingAddress: undefined } : req.body);

  // One of the store's manual methods: placed like cash on delivery, unpaid,
  // with a token the shopper's browser uses to send the transfer proof.
  const manualMethod =
    orderBody.paymentMethod === manualPayments.MANUAL_ORDER_METHOD
      ? await manualPayments.resolveForCheckout(workspaceId, manualPaymentMethodId)
      : null;
  const manualToken = manualMethod ? online.newPaymentToken() : null;
  const isOnline = orderBody.paymentMethod !== 'cod' && !manualMethod;
  if (isOnline && !env.payments.onlineEnabled) {
    // Exactly the refusal the COD-only checkout has always given.
    throw new ValidationError([{ field: 'paymentMethod', message: '"paymentMethod" must be [cod]' }], 'Invalid body');
  }

  let prepared = null;
  if (isOnline) {
    prepared = await online.prepareOnlineCheckout(workspace, { ...orderBody, paymentProvider, returnUrl }, req);
  } else if (env.payments.onlineEnabled && !manualMethod) {
    // The merchant may have switched cash on delivery off.
    await methodsService.resolveStorefrontMethod(workspace, { paymentMethod: 'cod' }, {
      preview: methodsService.isPreviewRequest(req, workspaceId),
    });
  }

  let items;
  let cart = null;

  if (cartToken) {
    cart = await require('../../db/models').Cart.findOne({
      where: { workspaceId, guestToken: cartToken, status: 'active' },
    });
    if (!cart) throw new AppError('CART_NOT_FOUND', 'No active cart found for this token', 404);
    ({ items } = await cartService.toOrderItems(workspaceId, cart.id));
  } else if (item) {
    items = [item, ...(extraItems || [])].map((line) => ({
      variantId: line.variantId,
      offerId: line.offerId,
      quantity: line.quantity || 1,
      customizations: line.customizations,
      options: line.options,
    }));
  } else {
    throw new AppError(
      'CART_TOKEN_OR_ITEM_REQUIRED',
      'Send an X-Cart-Token header, or a single `item` in the body for a "Buy Now" checkout',
      400
    );
  }
  // A funnel's checkout prices the funnel's way (shipping, coupons, payment methods): the
  // funnel must be a published one of this store that sells these lines (funnels/funnelCheckout.js).
  await require('../funnels/funnelCheckout').assertSells(workspaceId, orderBody.funnelId, items);

  // The ticked order bump becomes one more line of this order, built by the
  // server from the configured offer (422 when it is not that offer).
  if (orderBump) {
    items = [...items, await resolveOrderBumpItem(workspace, { offerId: orderBump.offerId, funnelId: orderBody.funnelId })];
  }

  // The product's own bumps: lines built by the server from the rules of the products being bought.
  if (orderBumps && orderBumps.length > 0) {
    const bumpItems = await require('../offers/offerRules').resolveBumpItems(workspace, orderBumps.map((b) => b.offerId), items);
    items = [...items, ...bumpItems.filter((b) => !items.some((i) => i.offerId === b.offerId))];
  }

  // A product A/B test: plain lines at the price their shopper was shown — the
  // cart's (whoever filled it) or this visitor's for a Buy Now. Funnels price their own way.
  const testVisitor = orderBody.funnelId ? null : (cart && cart.visitorId) || productTests.visitorOf(req);
  items = await productTests.pinPrices(workspaceId, items, testVisitor);

  // Stock held by overdue unpaid online orders goes back first.
  await online.expireOverdueHolding(workspaceId, [...new Set(items.map((i) => i.variantId).filter(Boolean))]);

  const context = { cartId: cart ? cart.id : null, checkoutSessionId: checkoutSessionId || null };
  // The shopper's answers to custom fields are checked again here, required
  // ones enforced; photos must be this visitor's or in this cart.
  const customFields = {
    enforceRequired: true,
    visitorId: req.headers['x-visitor-id'] ? readVisitorId(req) : null,
    cartId: cart ? cart.id : null,
  };

  if (!isOnline) {
    const { order, items: orderItems } = await orderService.createOrder(workspaceId, { ...orderBody, items }, req, {
      customFields,
      // A funnel with offers after its checkout (and the store's
      // funnel_upsell_merge on): nobody confirms the order until the shopper
      // is past them, so an accepted offer can still join it.
      confirmationAvailableAt: await offerWindowEnd(workspace, orderBody.funnelId),
      manualPayment: manualMethod ? { method: manualMethod, tokenHash: manualToken.hash } : null,
    });
    // createOrder has committed by now (no outer transaction here), and this
    // never throws: a conversion failure is logged, and the shopper still gets
    // the order they placed.
    await saveCheckoutAnswers(order, workspace, formFields);
    await creditProductTests(workspaceId, orderItems, testVisitor, order.id);
    await afterOrderCompleted(workspaceId, order, context);
    if (manualMethod) {
      const manualPayment = await manualPayments.getForShopper(workspaceId, order.id, manualToken.token);
      return res.status(201).json({ order: shopperOrder(order, orderItems), manualPayment, paymentToken: manualToken.token });
    }
    return res.status(201).json({ order: shopperOrder(order, orderItems) });
  }

  const { order, items: orderItems } = await orderService.createOrder(
    workspaceId,
    { ...orderBody, paymentMethod: prepared.method.method, items },
    req,
    {
      customFields,
      awaitingPayment: {
        expiresAt: prepared.expiresAt,
        tokenHash: prepared.tokenHash,
        completionContext: context,
      },
    }
  );

  await saveCheckoutAnswers(order, workspace, formFields);
  await creditProductTests(workspaceId, orderItems, testVisitor, order.id);

  const attempt = await online.startAttempt(order, {
    provider: prepared.method.provider,
    method: prepared.method.method,
    returnUrl: prepared.returnUrl,
  });

  res.status(201).json({
    order: shopperOrder(order, orderItems),
    payment: {
      id: attempt.id,
      status: attempt.status,
      provider: attempt.providerCode,
      method: attempt.method,
      mode: attempt.mode,
      redirectUrl: attempt.status === 'initialized' ? attempt.redirectUrl : null,
      failureReason: attempt.status === 'failed' ? attempt.failureReason : null,
      expiresAt: order.paymentExpiresAt,
    },
    paymentToken: prepared.token,
  });
});

module.exports = { checkout };
