'use strict';

/** Product specifications and comparison (modules/productSpecs, spec-gaps item 231). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('spec_keys', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      // { ar, en }
      name: { type: Sequelize.JSONB, allowNull: false },
      unit: { type: Sequelize.STRING(20), allowNull: true },
      // Offered as a storefront filter.
      filterable: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('spec_keys', ['workspace_id', 'position'], { name: 'spec_keys_ws_idx' });
    await queryInterface.createTable('product_specs', {
      product_id: { type: Sequelize.UUID, primaryKey: true, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      spec_key_id: { type: Sequelize.UUID, primaryKey: true, references: { model: 'spec_keys', key: 'id' }, onDelete: 'CASCADE' },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      value: { type: Sequelize.STRING(200), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('product_specs', ['workspace_id', 'spec_key_id', 'value'], { name: 'product_specs_filter_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('product_specs');
    await queryInterface.dropTable('spec_keys');
  },
};
