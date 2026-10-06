'use strict';

/**
 * Google Sheets sync (SPEC §16.4), modules/sheets:
 *
 *   sheet_connections  one sheet a store writes to: what it carries (orders or
 *                      lost orders), which ones (products / funnels), the
 *                      columns, one row per order or per product, and whether
 *                      it is active, paused or lost its access.
 *   sheet_row_refs     where each order or lost order was written in a sheet,
 *                      so a later change rewrites the same row(s).
 *
 * The Google account itself (its tokens, sealed) is a workspace_integrations
 * row with provider 'google_sheets'.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('sheet_connections', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(80), allowNull: false },
      data_type: { type: Sequelize.STRING(20), allowNull: false },
      spreadsheet_id: { type: Sequelize.STRING(200), allowNull: false },
      spreadsheet_url: { type: Sequelize.STRING(500), allowNull: true },
      sheet_name: { type: Sequelize.STRING(100), allowNull: false },
      filter: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      columns: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      group_by_order: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'active' },
      last_error: { type: Sequelize.STRING(500), allowNull: true },
      last_synced_at: { type: Sequelize.DATE, allowNull: true },
      rows_written: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('sheet_connections', ['workspace_id'], { name: 'sheet_connections_workspace_idx' });

    await queryInterface.createTable('sheet_row_refs', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      connection_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'sheet_connections', key: 'id' }, onDelete: 'CASCADE' },
      entity_type: { type: Sequelize.STRING(20), allowNull: false },
      entity_id: { type: Sequelize.UUID, allowNull: false },
      row_number: { type: Sequelize.INTEGER, allowNull: false },
      row_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      synced_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('sheet_row_refs', ['connection_id', 'entity_type', 'entity_id'], {
      unique: true,
      name: 'sheet_row_refs_connection_entity_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('sheet_row_refs');
    await queryInterface.dropTable('sheet_connections');
  },
};
