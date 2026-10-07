'use strict';

/** Where a partner app is told that a store uninstalled it (modules/partnerApps/jobs.js, spec-gaps item 267). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('partner_apps', 'uninstall_url', { type: Sequelize.STRING(500), allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('partner_apps', 'uninstall_url');
  },
};
