'use strict';

/** Stock lots (index.js): units leave their lots when the order ships; expiring lots are flagged daily. */
const svc = () => require('./index');

module.exports = {
  consumers: [{ name: 'stock_lots_consume', queue: 'default', events: ['order.shipped', 'order.delivered'], handle: (event) => svc().consumeForOrder(event) }],
  schedules: [{ name: 'stock_lots.alert_expiring', everyMs: 24 * 60 * 60 * 1000, handle: () => svc().alertExpiring() }],
};
