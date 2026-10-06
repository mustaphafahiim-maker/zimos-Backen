'use strict';

/**
 * Custom headers per webhook endpoint (webhooks/customHeaders.js): sent with
 * every delivery, values sealed (they are often an API key).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('webhook_endpoints', 'custom_headers', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('webhook_endpoints', 'custom_headers');
  },
};
