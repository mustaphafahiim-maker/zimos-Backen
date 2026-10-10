'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Custom headers per webhook endpoint (webhooks/customHeaders.js, STORE_FEATURES
 * webhook_headers): sent with every delivery, values sealed (they are often
 * an API key). Additive and run-twice safe: a constant default, no rewrite.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('webhook_endpoints', 'custom_headers', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('webhook_endpoints', 'custom_headers');
  },
};
