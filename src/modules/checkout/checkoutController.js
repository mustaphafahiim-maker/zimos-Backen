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
const productTests = require('../catalog/productTests');
const logger = require('../../core/utils/logger');

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
  // eslint-disable-next-line no-unused-vars -- the billing keys are read by checkoutExtras, not by the order.
  const { item, extraItems, orderBumps, checkoutSessionId, paymentProvider, returnUrl, orderBump, formFields, transfer, saveCard, pageTags, billingAddress, billingSameAsShipping, giftCardCode, loyaltyPoints, useStoreCredit, gift, deliverySlot, trackingConsent, ...orderBody } = req.body;
  const workspace = req.publicWorkspace;
  const workspaceId = req.tenant.workspaceId;

  // A store on a "pause" holiday takes no orders (holidayMode, item 216).
  require('../holidayMode').assertOpen(workspace);
  // Per-store required fields (settings.checkout_settings). Checked before any
  // cart work so a rejected checkout costs nothing.
  assertRequiredCheckoutFields(workspace, req.body);
  // A place the store hid is not delivered to (shipping/shippingPlaces.js).
  await require('../shipping/shippingPlaces').assertDeliverable(workspace, req.body.shippingAddress);
  // A hidden or unknown place of the store's own list (places/placePricing.js).
  await require('../places/placePricing').assertDeliverable(workspace.id, req.body.shippingAddress);
  // Photo answers and the billing address, checked now and saved with the order (checkoutExtras.js).
  const extras = await require('./checkoutExtras').prepare(workspace, req);

  // A manual transfer (the whole order, or a COD order's deposit) is checked
  // here, before any cart work; it is not an online (gateway) payment.
  const manualTransfer = await manualCheckout.prepare(workspace, { paymentMethod: orderBody.paymentMethod, transfer, contact: orderBody.contact }, req);
  const isOnline = orderBody.paymentMethod !== 'cod' && orderBody.paymentMethod !== 'bank_transfer';
  if (orderBody.paymentMethod === 'cod') paymentRules.assertAllowedInFunnel(workspace, { funnelId: orderBody.funnelId, methodId: 'cod' });
  // A gift card lowers what the courier collects (COD, item 189) or what the gateway charges (online, item 201).
  if (giftCardCode) {
    if (orderBody.paymentMethod === 'bank_transfer') throw new ValidationError([{ field: 'giftCardCode', message: 'A gift card can be used with cash on delivery or an online payment' }], 'Invalid body');
    await require('../giftCards/giftCardService').assertUsable(workspaceId, giftCardCode, null);
  }
  // Loyalty points: only a signed-in shopper's, checked now and taken once the order exists (loyalty/, item 203).
  let pointsOwner = null;
  if (loyaltyPoints) {
    if (orderBody.paymentMethod === 'bank_transfer') throw new ValidationError([{ field: 'loyaltyPoints', message: 'Points can be used with cash on delivery or an online payment' }], 'Invalid body');
    const shopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    pointsOwner = await require('../loyalty/loyaltyService').assertCanSpend(workspace, shopper, loyaltyPoints);
  }
  // Store credit, also only a signed-in shopper's (storeCredit/, item 204).
  let creditOwner = null;
  if (useStoreCredit) {
    if (orderBody.paymentMethod === 'bank_transfer') throw new ValidationError([{ field: 'useStoreCredit', message: 'Store credit can be used with cash on delivery or an online payment' }], 'Invalid body');
    const shopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    creditOwner = await require('../storeCredit/storeCreditService').assertCanSpend(workspace, shopper);
  }
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
  // With the Offers app off the store shows no add-ons, so a ticked one is stale or forged.
  if (((orderBump && !orderBody.funnelId) || (orderBumps && orderBumps.length > 0)) && !(await require('../apps/appGate').isEnabled(workspace.id, 'offers'))) {
    throw new AppError('ORDER_BUMP_INVALID', 'This add-on is no longer offered', 422);
  }
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
  // A signed-in wholesale customer's price lists, lower prices only (priceLists/, item 205). Funnels keep their own prices.
  if (!orderBody.funnelId && req.headers['x-shopper-token']) {
    const listShopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    if (listShopper) items = await require('../priceLists').pinPrices(workspaceId, items, listShopper);
  }
  // A free trial prices its product at nothing on the first order (subscriptions/trialCheckout.js).
  items = await require('../subscriptions/trialCheckout').pinTrialLines(workspaceId, items, orderBody.contact);
  // Each product's min / max per order and max per customer (catalog/purchaseLimits.js, item 198).
  await require('../catalog/purchaseLimits').assertWithin(workspaceId, items, orderBody.contact);
  // The signed-in shopper's VIP tier: a percent off plain lines and/or free shipping (vipTiers/, item 218). Not in funnels.
  if (!orderBody.funnelId && req.headers['x-shopper-token']) {
    const vipShopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    if (vipShopper) ({ items } = await require('../vipTiers').applyAtCheckout(workspace, items, vipShopper, orderBody));
  }
  // Free gifts the order earns, added by the server at no charge (freeGifts/, item 208). Funnels keep their own offers.
  if (!orderBody.funnelId) ({ items } = await require('../freeGifts').addGifts(workspace, items));
  // Gift wrap is a line of the merchant's wrap product; the message is kept on the order (giftOptions, item 214).
  const giftChoice = await require('../giftOptions').prepare(workspace, gift);
  if (giftChoice && giftChoice.line) items = [...items, giftChoice.line];
  // The delivery day and time slot: a place is held now and given to the order once it exists (deliverySlots/, item 221).
  const slotBooking = await require('../deliverySlots').hold(workspace, deliverySlot);

  // The gateway takes the order's currency, or the order is not created (payments/methodCurrency.js).
  if (isOnline) {
    const methodCurrency = require('../payments/methodCurrency');
    methodCurrency.assertTakes(prepared.method, await methodCurrency.itemsCurrency(workspaceId, items));
  }

  // Stock held by overdue unpaid online orders goes back first.
  await online.expireOverdueHolding(workspaceId, [...new Set(items.map((i) => i.variantId).filter(Boolean))]);

  // A subscription or installment product needs a card that can be saved (SPEC §18.1). Its card
  // is saved by subscriptionService.startForOrder once paid, so the shopper's own tick is not used twice.
  const planned = await require('../subscriptions/planCheckout').assertPayable(workspaceId, items, isOnline ? prepared.method : { method: orderBody.paymentMethod });
  const context = { cartId: cart ? cart.id : null, checkoutSessionId: checkoutSessionId || null, ...(saveCard === true && !planned ? { saveCard: true } : {}) };
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
    await require('./checkoutExtras').apply(order, extras);
    await require('../marketing/cookieConsent').recordOnOrder(order, trackingConsent);
  await require('../shipping/deliveryEstimates').recordOnOrder(workspace, order, req.body.shippingAddress);
    await require('../giftOptions').recordOnOrder(order, giftChoice);
    await require('../holidayMode').markOrder(workspace, order);
    await require('../deliverySlots').attach(order, slotBooking);
    await creditProductTests(workspaceId, orderItems, testVisitor, order.id);
    // Tags from the website page's buy button or order form the shopper used (contacts/pageTags.js).
    await require('../contacts/pageTags').tagFromPages(workspaceId, order, pageTags);
    await afterOrderCompleted(workspaceId, order, context);
    const transferPayment = await manualCheckout.record(order, manualTransfer);
    const giftCard = giftCardCode ? await require('../giftCards/giftCardService').redeemOnOrder(order, giftCardCode, req) : null;
    const credit = creditOwner ? await require('../storeCredit/storeCreditService').spendOnOrder(order, creditOwner.id, { req }) : null;
    const points = pointsOwner ? await require('../loyalty/loyaltyService').spendOnOrder(order, pointsOwner.id, loyaltyPoints, { req }) : null;
    if ((giftCard && giftCard.applied) || (points && points.applied) || (credit && credit.applied)) await order.reload();
    return res.status(201).json({ order: { ...order.toJSON(), items: orderItems }, ...(transferPayment ? { transfer: transferPayment } : {}), ...(giftCard ? { giftCard } : {}), ...(credit ? { storeCredit: credit } : {}), ...(points ? { loyalty: points } : {}) });
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
  await require('./checkoutExtras').apply(order, extras);
  await require('../marketing/cookieConsent').recordOnOrder(order, trackingConsent);
  await require('../shipping/deliveryEstimates').recordOnOrder(workspace, order, req.body.shippingAddress);
  await require('../giftOptions').recordOnOrder(order, giftChoice);
    await require('../holidayMode').markOrder(workspace, order);
    await require('../deliverySlots').attach(order, slotBooking);
  await creditProductTests(workspaceId, orderItems, testVisitor, order.id);
  await require('../contacts/pageTags').tagFromPages(workspaceId, order, pageTags);

  // The card's part is held now and taken when the payment lands (giftCards/giftCardHolds.js, item 201).
  let giftCard = giftCardCode ? await require('../giftCards/giftCardHolds').hold(order, giftCardCode).catch(() => ({ applied: false, reason: 'error' })) : null;
  // Points too (loyalty/, item 203), held the same way.
  let credit = creditOwner ? await require('../storeCredit/storeCreditService').spendOnOrder(order, creditOwner.id, { held: true }) : null;
  let points = pointsOwner ? await require('../loyalty/loyaltyService').spendOnOrder(order, pointsOwner.id, loyaltyPoints, { held: true }) : null;
  const heldNow = (giftCard && giftCard.applied) || (points && points.applied) || (credit && credit.applied) ? await require('../payments/heldTenders').heldOn(order.id) : 0;
  if (heldNow > 0 && heldNow >= Number(order.totalAmount) - Number(order.amountPaid)) {
    // Nothing left for the gateway: the order goes on as cash on delivery with nothing to collect.
    try {
      await online.switchToCod(workspaceId, order.id, prepared.token, req);
      const paidOrder = await require('../../db/models').Order.findByPk(order.id);
      const { coversOrder, ...card } = giftCard || {};
      return res.status(201).json({
        order: { ...paidOrder.toJSON(), items: orderItems },
        ...(giftCard ? { giftCard: { ...card, held: false } } : {}),
        ...(credit ? { storeCredit: { ...credit, held: false } } : {}),
        ...(points ? { loyalty: { ...points, held: false } } : {}),
        paidByGiftCard: Boolean(giftCard && giftCard.applied),
        paidInStore: true,
      });
    } catch (err) {
      // COD not offered (or refused): the card and points go back and the gateway takes the whole order.
      await require('../../db/models').sequelize.transaction((t) => require('../payments/heldTenders').release(order.id, t, 'cash on delivery unavailable'));
      if (giftCard && giftCard.applied) giftCard = { applied: false, reason: 'covers_order_cod_unavailable' };
      if (points && points.applied) points = { applied: false, reason: 'covers_order_cod_unavailable' };
      if (credit && credit.applied) credit = { applied: false, reason: 'covers_order_cod_unavailable' };
    }
  }

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
    ...(giftCard ? { giftCard: (({ coversOrder, ...card }) => card)(giftCard) } : {}),
    ...(credit ? { storeCredit: credit } : {}),
    ...(points ? { loyalty: points } : {}),
  });
});

module.exports = { checkout };
