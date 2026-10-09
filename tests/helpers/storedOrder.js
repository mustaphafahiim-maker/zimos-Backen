'use strict';

const db = require('../../src/db/models');

/**
 * The stored order behind a storefront checkout answer. The answer leaves out
 * what the store knows about the shopper (checkout/shopperOrder.js: risk
 * flags, customer id, IP…), so tests read those from the row.
 */
async function storedOrder(res) {
  const id = res && res.body && res.body.order && res.body.order.id;
  if (!id) throw new Error(`no order in the answer (status ${res && res.status})`);
  return (await db.Order.findByPk(id)).toJSON();
}

module.exports = { storedOrder };
