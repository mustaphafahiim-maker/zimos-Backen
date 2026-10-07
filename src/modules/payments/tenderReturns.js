'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/*
 * Points, store credit and gift cards spent on an order go back to the
 * shopper when the order is cancelled or rejected (item 274). Such an order
 * can't come back to life (reopen, a rejection corrected to confirmed): the
 * courier would collect only what was left, with the tender already returned.
 * The team makes a new order instead.
 */
const STORE_TENDERS = ['gift_card', 'loyalty', 'store_credit'];

async function assertNoneReturned(orderId, transaction) {
  const returned = await db.Refund.count({
    where: { orderId, status: 'processed' },
    include: [{ model: db.Payment, as: 'payment', where: { providerCode: STORE_TENDERS }, attributes: [], required: true }],
    transaction,
  });
  if (returned > 0) {
    throw new AppError('ORDER_TENDER_RETURNED', 'The points, store credit or gift card paid on this order were given back when it was cancelled; place a new order instead', 409);
  }
}

module.exports = { STORE_TENDERS, assertNoneReturned };
