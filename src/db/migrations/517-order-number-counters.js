'use strict';

/**
 * Short sequential order numbers (item 381): one counter row per store.
 *
 *   last_number  the last number an order of this store took (0 = none yet)
 *
 * orders/orderNumbers.js takes the next one with a single
 * INSERT … ON CONFLICT DO UPDATE … RETURNING inside the order's own
 * transaction, so the row stays locked until that order commits or rolls
 * back: two orders of one store never share a number. BIGINT because a store
 * may start at up to 10^9.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('order_number_counters', {
      workspace_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      last_number: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('order_number_counters');
  },
};
