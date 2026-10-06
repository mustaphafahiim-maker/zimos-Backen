'use strict';

/** Click and collect (index.js): a cancelled order's pickup is cancelled. */
module.exports = {
  consumers: [{ name: 'click_and_collect_cancelled', queue: 'default', events: ['order.cancelled'], handle: (event) => require('./index').onOrderCancelled(event) }],
};
