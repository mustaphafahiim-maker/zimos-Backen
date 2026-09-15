'use strict';
const asyncHandler = require('express-async-handler');
const cartService = require('../cart/cartService');
const orderService = require('../orders/orderService');
const checkoutSessionService = require('./checkoutSessionService');
const { AppError } = require('../../core/errors/AppError');

/**
 * Guest checkout (no login). Runs the same orderService.createOrder as the
 * staff API. Two ways in: an `X-Cart-Token` header builds the order from that
 * cart's lines, or — with no token — a single `item` in the body ("Buy now")
 * goes straight to an order with no cart. The cart wins if both are given.
 */
const checkout = asyncHandler(async (req, res) => {
  const cartToken = req.headers['x-cart-token'];
  const { item, checkoutSessionId, ...orderBody } = req.body;

  // The merchant's checkout form settings are enforced here, not only in the UI.
  const workspace = await require('../../db/models').Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] });
  const form = (workspace && workspace.settings && workspace.settings.checkout_settings) || {};
  if (form.allow_discount_codes === false) delete orderBody.discountCode;
  const missing = [];
  if (form.email === 'required' && !(orderBody.contact && orderBody.contact.email)) missing.push({ field: 'contact.email', message: 'Email is required' });
  if (form.alternate_phone === 'required' && !(orderBody.contact && orderBody.contact.alternatePhone)) missing.push({ field: 'contact.alternatePhone', message: 'Alternative phone is required' });
  if (form.notes === 'required' && !orderBody.notes) missing.push({ field: 'notes', message: 'Notes are required' });
  if (missing.length > 0) throw new AppError('VALIDATION_ERROR', missing[0].message, 422, missing);

  let items;
  let cart = null;

  if (cartToken) {
    cart = await require('../../db/models').Cart.findOne({
      where: { workspaceId: req.tenant.workspaceId, guestToken: cartToken, status: 'active' },
    });
    if (!cart) throw new AppError('CART_NOT_FOUND', 'No active cart found for this token', 404);
    ({ items } = await cartService.toOrderItems(req.tenant.workspaceId, cart.id));
  } else if (item) {
    items = [{ variantId: item.variantId, offerId: item.offerId, quantity: item.quantity || 1 }];
  } else {
    throw new AppError(
      'CART_TOKEN_OR_ITEM_REQUIRED',
      'Send an X-Cart-Token header, or a single `item` in the body for a "Buy Now" checkout',
      400
    );
  }

  const { order, items: orderItems } = await orderService.createOrder(
    req.tenant.workspaceId,
    { ...orderBody, items },
    req
  );

  if (cart) await cartService.markConverted(cart.id, order.id);

  // Close the shopper's abandoned-checkout sessions; never fail the order over it.
  await checkoutSessionService
    .markConvertedForOrder(req.tenant.workspaceId, { sessionId: checkoutSessionId, phone: orderBody.contact && orderBody.contact.phone, orderId: order.id })
    .catch(() => undefined);

  res.status(201).json({ order: { ...order.toJSON(), items: orderItems } });
});

module.exports = { checkout };
