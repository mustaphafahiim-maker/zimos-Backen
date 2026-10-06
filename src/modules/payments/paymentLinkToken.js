'use strict';

const crypto = require('crypto');
const env = require('../../config/env');

/**
 * The payment link a message carries (SPEC §11.4: "Try again" after a failed
 * payment). The shopper's own payment token is shown once, at checkout, and
 * only its hash is kept — a message sent later can't hold it, and minting a
 * fresh one would break the page the shopper may still have open. So the
 * message's link carries a signed token instead: it names this order in this
 * store and nothing else, and opens the same /pay page with the same actions
 * (status, try again, switch to cash on delivery). Whether the order can still
 * be paid is the order's own window, not the link's.
 *
 * Told apart from the shopper's random token by its `pl_` prefix and its
 * signature (a random token that happens to start the same simply fails the
 * signature and is checked against the stored hash as before). Letters,
 * digits, - and _ only, like the token the /pay page already accepts.
 */

const PREFIX = 'pl_';

const sign = (workspaceId, orderId) =>
  crypto.createHmac('sha256', env.jwt.accessSecret).update(`order-pay:${workspaceId}.${orderId}`).digest('base64url').slice(0, 32);

function linkTokenFor(order) {
  return `${PREFIX}${sign(order.workspaceId, order.id)}`;
}

function linkTokenMatches(order, token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return false;
  const given = Buffer.from(token.slice(PREFIX.length));
  const expected = Buffer.from(sign(order.workspaceId, order.id));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { linkTokenFor, linkTokenMatches };
