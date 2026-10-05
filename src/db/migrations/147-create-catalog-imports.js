'use strict';

const { guarded } = require('../migrationGuards');

/**
 * One row per product import (SPEC §7.5): a JSON file, a CSV/xlsx sheet or a
 * Shopify product link. The parsed products wait in `payload` for the `io`
 * queue job; the job writes how many were created and, per failed product,
 * why — that is the error report the merchant reads.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.createTable('catalog_imports', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4, allowNull: false },
      workspace_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
      },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'queued' },
      source_name: { type: Sequelize.STRING(300), allowNull: true },
      payload: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      total: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      errors: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      created_by: { type: Sequelize.UUID, allowNull: true },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('catalog_imports', ['workspace_id', 'created_at'], {
      name: 'catalog_imports_workspace_created',
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('catalog_imports');
  },
};
