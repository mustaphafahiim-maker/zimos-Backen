'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently } = require('../concurrentIndex');

/**
 * Where a storefront order came from: the shopper's IP, the country that IP
 * resolves to (modules/risk/ipIntel) and their browser. Staff-created orders
 * leave all three null. Read by the per-IP fraud rule, the risk score and the
 * "Block IP" button of the order page.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('orders', 'ip_address', { type: DataTypes.STRING(45), allowNull: true });
    await queryInterface.addColumn('orders', 'ip_country', { type: DataTypes.STRING(2), allowNull: true });
    await queryInterface.addColumn('orders', 'user_agent', { type: DataTypes.STRING(400), allowNull: true });
    await createIndexConcurrently(queryInterface, { name: 'orders_ws_ip_created_idx', table: 'orders', definition: `(workspace_id, ip_address, created_at) WHERE ip_address IS NOT NULL` });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS orders_ws_ip_created_idx');
    await queryInterface.removeColumn('orders', 'user_agent');
    await queryInterface.removeColumn('orders', 'ip_country');
    await queryInterface.removeColumn('orders', 'ip_address');
  },
};
