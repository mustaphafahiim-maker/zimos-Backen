'use strict';

/** Stock locations (index.js): a new order is assigned the location it ships from. */
// eslint-disable-next-line global-require
module.exports = { consumers: [{ name: 'stock_locations_assign', queue: 'default', events: ['order.created'], handle: (event) => require('./index').assignOrder(event) }] };
