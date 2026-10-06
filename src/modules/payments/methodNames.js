'use strict';

/**
 * The ways an order can be paid (orders.payment_method), in one place.
 *
 *   cod            cash on delivery
 *   card, wallet   online, through the store's gateway
 *   valu           valU installments, through the gateway (Paymob)
 *   kiosk          a reference paid in cash at an Aman / Masary outlet,
 *                  through the gateway (Paymob); the order waits longer for
 *                  it (PAYMENT_KIOSK_TTL_MINUTES)
 *   paypal         PayPal (approve on PayPal, captured on the way back;
 *                  gateways/paypal.js), shown as an express button
 *   bank_transfer  a manual transfer with a receipt (checkout/manualCheckout.js)
 */

const ONLINE_METHODS = Object.freeze(['card', 'wallet', 'valu', 'kiosk', 'paypal']);
const ORDER_METHODS = Object.freeze(['cod', ...ONLINE_METHODS, 'bank_transfer']);

const isOnline = (method) => ONLINE_METHODS.includes(method);

module.exports = { ONLINE_METHODS, ORDER_METHODS, isOnline };
