'use strict';

/**
 * Store scripts targeted by position and page type (modules/customCode/storeScripts.js):
 * a store script is a workspace_custom_code row with slot `ss:<id>`; its name,
 * position (head, body_start, body_end) and page types live in `options`.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('workspace_custom_code', 'options', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('workspace_custom_code', 'options');
  },
};
