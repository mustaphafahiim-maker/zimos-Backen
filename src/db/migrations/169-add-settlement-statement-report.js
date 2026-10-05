'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A settlement created from a courier's statement keeps the result of the
 * match: which waybills were not found, which amounts disagreed, and which
 * delivered orders the statement left out.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('cod_settlements', 'statement_report', { type: Sequelize.DataTypes.JSONB, allowNull: true });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('cod_settlements', 'statement_report');
  },
};
