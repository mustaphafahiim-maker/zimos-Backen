'use strict';

/**
 * A settlement created from a courier's statement keeps the result of the
 * match: which waybills were not found, which amounts disagreed, and which
 * delivered orders the statement left out.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('cod_settlements', 'statement_report', { type: Sequelize.DataTypes.JSONB, allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('cod_settlements', 'statement_report');
  },
};
