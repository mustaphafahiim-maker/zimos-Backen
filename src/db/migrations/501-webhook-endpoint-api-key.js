'use strict';

/**
 * Which API key created a webhook endpoint (spec-gaps item 266): an outside
 * or partner app that subscribes through the public API loses its endpoints
 * with its key — uninstalling the app stops the store's data from going to it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('webhook_endpoints', 'api_key_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'api_keys', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('webhook_endpoints', ['api_key_id'], { name: 'webhook_endpoints_api_key_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('webhook_endpoints', 'api_key_id');
  },
};
