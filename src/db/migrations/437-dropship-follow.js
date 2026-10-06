'use strict';

/**
 * Following a forwarded order at the supplier (dropship/dropshipOrders.js):
 * when its status was last asked for, what went wrong the last time, and
 * whether it was forwarded by hand or automatically.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('dropship_order_refs', 'checked_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('dropship_order_refs', 'last_error', { type: Sequelize.STRING(500), allowNull: true });
    await queryInterface.addColumn('dropship_order_refs', 'forwarded_by', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'manual' });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('dropship_order_refs', 'forwarded_by');
    await queryInterface.removeColumn('dropship_order_refs', 'last_error');
    await queryInterface.removeColumn('dropship_order_refs', 'checked_at');
  },
};
