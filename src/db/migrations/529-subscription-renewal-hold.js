'use strict';

/**
 * customer_subscriptions.renewal_hold (item 394, subscriptions/renewalHolds.js):
 * a renewal the store could not take — the gateway refused its keys or did
 * not answer, the product is sold out or no longer sold, the store is
 * suspended or out of balance. Not the shopper's doing, so no attempt is
 * counted and they are not told; it is tried again on its own schedule.
 * { cause, causeKey, reason, since, tries, orderId, savedMethodId, unknown,
 * warnedAt }; null when nothing holds the renewal.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('customer_subscriptions', 'renewal_hold', { type: Sequelize.JSONB, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('customer_subscriptions', 'renewal_hold');
  },
};
