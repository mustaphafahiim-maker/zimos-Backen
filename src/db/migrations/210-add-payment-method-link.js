'use strict';

const { guarded } = require('../migrationGuards');

/**
 * An optional payment link (https, e.g. an InstaPay link) next to the account
 * number of the platform's own manual methods (payment_methods, migration
 * 130). Null means no link: merchants see the number only.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('payment_methods', 'payment_link', { type: DataTypes.STRING(500), allowNull: true });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query('ALTER TABLE payment_methods DROP COLUMN IF EXISTS payment_link');
  },
};
