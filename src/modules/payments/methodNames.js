'use strict';

/**
 * The ways an order can be paid (orders.payment_method), in one place.
 *
 *   cod            cash on delivery
 *   card, wallet   online, through the store's gateway
 *   bank_transfer  recorded by staff for a transfer the merchant received
 *
 * The storefront checkout takes cod, card and wallet; staff order creation
 * takes every method.
 */

const ONLINE_METHODS = Object.freeze(['card', 'wallet']);
const STOREFRONT_METHODS = Object.freeze(['cod', ...ONLINE_METHODS]);
const ORDER_METHODS = Object.freeze(['cod', ...ONLINE_METHODS, 'bank_transfer']);

const isOnline = (method) => ONLINE_METHODS.includes(method);

module.exports = { ONLINE_METHODS, STOREFRONT_METHODS, ORDER_METHODS, isOnline };
