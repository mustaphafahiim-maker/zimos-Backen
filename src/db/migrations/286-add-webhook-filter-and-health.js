'use strict';

/**
 * Webhook endpoints (SPEC §16.1):
 *
 * filter          only events about these funnels / products are sent:
 *                 { "funnelIds": [...], "productIds": [...] }. Null = everything.
 * failing_since   when the current unbroken run of failed deliveries began;
 *                 cleared by the next success.
 * disabled_at /   set when the endpoint was switched off automatically after
 * disabled_reason failing for three days. Cleared when the merchant turns it
 *                 back on.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('webhook_endpoints', 'filter', { type: DataTypes.JSONB, allowNull: true });
    await queryInterface.addColumn('webhook_endpoints', 'failing_since', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('webhook_endpoints', 'disabled_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('webhook_endpoints', 'disabled_reason', { type: DataTypes.STRING(60), allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('webhook_endpoints', 'disabled_reason');
    await queryInterface.removeColumn('webhook_endpoints', 'disabled_at');
    await queryInterface.removeColumn('webhook_endpoints', 'failing_since');
    await queryInterface.removeColumn('webhook_endpoints', 'filter');
  },
};
