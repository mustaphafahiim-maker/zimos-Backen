'use strict';

/** Store credit (storeCreditService.js): a cancelled order puts spent credit back. */
// eslint-disable-next-line global-require
const svc = () => require('./storeCreditService');
svc().install();

module.exports = {
  consumers: [{ name: 'store_credit_cancelled', queue: 'default', events: ['order.cancelled', 'order.rejected'], handle: (event) => svc().onOrderCancelled(event) }],
};
