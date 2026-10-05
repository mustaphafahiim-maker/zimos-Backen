'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently } = require('../concurrentIndex');

/**
 * `orders.device_id`: the browser the storefront order came from (an id the
 * storefront keeps in localStorage). Read by the device blocklist, the "more
 * than two orders from one device in an hour" risk signal and the order
 * page's "Block device".
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('orders', 'device_id', { type: DataTypes.STRING(128), allowNull: true });
    await createIndexConcurrently(queryInterface, { name: 'orders_ws_device_created_idx', table: 'orders', definition: `(workspace_id, device_id, created_at) WHERE device_id IS NOT NULL` });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS orders_ws_device_created_idx');
    await queryInterface.removeColumn('orders', 'device_id');
  },
};
