'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Store pickup (shipping/storePickup.js): an order the customer collects
 * from the store carries orders.delivery_method = 'pickup'. NULL is the
 * order as every order has been until now — delivered to its address.
 *
 * VARCHAR + CHECK. orders is large, so the CHECK is added NOT VALID: it binds
 * every new or updated row without scanning the existing ones (all NULL,
 * which the CHECK accepts anyway). Adding a nullable column without a
 * default is a catalogue change only.
 */
const VALUES = ['delivery', 'pickup'];
const CHECK = 'orders_delivery_method_check';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('orders', 'delivery_method', { type: Sequelize.DataTypes.STRING(20), allowNull: true });
    const [rows] = await queryInterface.sequelize.query('SELECT 1 FROM pg_constraint WHERE conname = :name', { replacements: { name: CHECK } });
    if (rows.length === 0) {
      await queryInterface.sequelize.query(
        `ALTER TABLE orders ADD CONSTRAINT ${CHECK} CHECK (delivery_method IS NULL OR delivery_method IN (${VALUES.map((v) => `'${v}'`).join(', ')})) NOT VALID`
      );
    }
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS ${CHECK}`);
    await queryInterface.removeColumn('orders', 'delivery_method');
  },
};
