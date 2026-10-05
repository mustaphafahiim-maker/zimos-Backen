'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Sidebar shortcuts (SPEC §18.6): the dashboard pages a member pinned, as an
 * ordered list of routes. Per membership, so each person has their own list
 * in each store.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('memberships', 'nav_shortcuts', {
      type: Sequelize.DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    });
  },
  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('memberships', 'nav_shortcuts');
  },
};
