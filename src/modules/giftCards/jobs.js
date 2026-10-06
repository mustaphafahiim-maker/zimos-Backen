'use strict';

/**
 * Gift cards in the background (giftCardService.js): a paid or delivered order
 * issues the cards it sold; a cancelled one gives its card balance back.
 */
// eslint-disable-next-line global-require
const svc = () => require('./giftCardService');

module.exports = {
  consumers: [
    { name: 'gift_cards_issue', queue: 'default', events: ['order.paid', 'order.delivered'], handle: (event) => svc().issueForOrder(event) },
    { name: 'gift_cards_cancel', queue: 'default', events: ['order.cancelled'], handle: (event) => svc().refundCancelledOrder(event) },
  ],
};
