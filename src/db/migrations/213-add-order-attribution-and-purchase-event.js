'use strict';

/**
 * SPEC §13.3 and §13.4, on the order:
 *
 *   attribution             how the shopper reached the store — the first and
 *                           the last touch (utm_*, click ids, ref, referrer,
 *                           landing page) from the storefront's 30-day cookie
 *   session_stats           first visit, visits, pages and time on the store
 *                           before buying, from the store's own analytics
 *   purchase_event_sent_at  when the Purchase conversion went to the ad
 *                           platforms, so it is sent once whichever moment the
 *                           merchant chose (order, confirmation or delivery)
 *
 * Orders that already exist count as sent: they were reported at creation,
 * which is how it worked before the timing setting existed.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('orders', 'attribution', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('orders', 'session_stats', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('orders', 'purchase_event_sent_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.sequelize.query('UPDATE orders SET purchase_event_sent_at = created_at');
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'purchase_event_sent_at');
    await queryInterface.removeColumn('orders', 'session_stats');
    await queryInterface.removeColumn('orders', 'attribution');
  },
};
