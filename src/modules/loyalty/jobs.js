'use strict';

/** Loyalty points (loyaltyService.js): earn on delivery, take back on return or cancel, expire inactive balances. */
// eslint-disable-next-line global-require
const svc = () => require('./loyaltyService');
svc().install();

module.exports = {
  consumers: [
    { name: 'loyalty_earn', queue: 'default', events: ['order.delivered'], handle: (event) => svc().earnForOrder(event) },
    { name: 'loyalty_returned', queue: 'default', events: ['order.returned'], handle: (event) => svc().onOrderReturned(event) },
    { name: 'loyalty_cancelled', queue: 'default', events: ['order.cancelled', 'order.rejected'], handle: (event) => svc().onOrderCancelled(event) },
  ],
  schedules: [{ name: 'loyalty.expire', everyMs: 24 * 60 * 60 * 1000, handle: () => svc().expireInactive() }],
};
