'use strict';

/**
 * Size charts (modules/sizeCharts, spec-gaps item 210): a reusable size table
 * attached to products and/or collections, shown on the product page.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('size_charts', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      // cm | inch — the unit the numbers are entered in
      unit: { type: Sequelize.STRING(5), allowNull: false, defaultValue: 'cm' },
      // [{ ar, en }] column headings; rows: [[cell, …]] (strings)
      columns: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      rows: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      note: { type: Sequelize.JSONB, allowNull: true },
      image_url: { type: Sequelize.STRING(1000), allowNull: true },
      product_ids: { type: Sequelize.ARRAY(Sequelize.UUID), allowNull: false, defaultValue: [] },
      collection_ids: { type: Sequelize.ARRAY(Sequelize.UUID), allowNull: false, defaultValue: [] },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('size_charts', ['workspace_id'], { name: 'size_charts_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('size_charts');
  },
};
