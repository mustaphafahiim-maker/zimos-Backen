'use strict';
const asyncHandler = require('express-async-handler');
const manualCheckout = require('./manualCheckout');
const paymentRules = require('../payments/paymentRulesService');
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
const { resolveOrderBumpItem } = require('./orderBump');
const { offerWindowEnd } = require('../funnels/funnelOfferMerge');

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
  const { item, extraItems, checkoutSessionId, paymentProvider, returnUrl, orderBump, formFields, transfer, ...orderBody } = req.body;
  const workspace = req.publicWorkspace;
  const workspaceId = req.tenant.workspaceId;

  // Per-store required fields (settings.checkout_settings). Checked before any
  // cart work so a rejected checkout costs nothing.
  assertRequiredCheckoutFields(workspace, req.body);

  // A manual transfer (the whole order, or a COD order's deposit) is checked
  // here, before any cart work; it is not an online (gateway) payment.
  const manualTransfer = await manualCheckout.prepare(workspace, { paymentMethod: orderBody.paymentMethod, transfer, contact: orderBody.contact }, req);
  const isOnline = orderBody.paymentMethod !== 'cod' && orderBody.paymentMethod !== 'bank_transfer';
  if (orderBody.paymentMethod === 'cod') paymentRules.assertAllowedInFunnel(workspace, { funnelId: orderBody.funnelId, methodId: 'cod' });
  if (isOnline && !env.payments.onlineEnabled) {
    // Exactly the refusal the COD-only checkout has always given.
    throw new ValidationError([{ field: 'paymentMethod', message: '"paymentMethod" must be [cod]' }], 'Invalid body');
  }

  let prepared = null;
  if (isOnline) {
    prepared = await online.prepareOnlineCheckout(workspace, { ...orderBody, paymentProvider, returnUrl }, req);
    paymentRules.assertAllowedInFunnel(workspace, { funnelId: orderBody.funnelId, methodId: `${prepared.method.provider}:${prepared.method.method}` });
  } else if (env.payments.onlineEnabled && orderBody.paymentMethod === 'cod') {
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
    }));
  } else {
    throw new AppError(
      'CART_TOKEN_OR_ITEM_REQUIRED',
      'Send an X-Cart-Token header, or a single `item` in the body for a "Buy Now" checkout',
      400
    );
  }

  // The ticked order bump becomes one more line of this order, built by the
  // server from the configured offer (422 when it is not that offer).
  if (orderBump) {
    items = [...items, await resolveOrderBumpItem(workspace, { offerId: orderBump.offerId, funnelId: orderBody.funnelId })];
  }

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
    });
    // createOrder has committed by now (no outer transaction here), and this
    // never throws: a conversion failure is logged, and the shopper still gets
    // the order they placed.
    await saveCheckoutAnswers(order, workspace, formFields);
    await afterOrderCompleted(workspaceId, order, context);
    const transferPayment = await manualCheckout.record(order, manualTransfer);
    return res.status(201).json({ order: { ...order.toJSON(), items: orderItems }, ...(transferPayment ? { transfer: transferPayment } : {}) });
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

  const attempt = await online.startAttempt(order, {
    provider: prepared.method.provider,
    method: prepared.method.method,
    returnUrl: prepared.returnUrl,
  });

  res.status(201).json({
    order: { ...order.toJSON(), items: orderItems },
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
