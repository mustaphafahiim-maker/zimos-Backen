'use strict';

/** Products bought in the same orders, worked out nightly (modules/boughtTogether, spec-gaps item 223). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('product_affinities', {
      workspace_id: { type: Sequelize.UUID, allowNull: false, primaryKey: true, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      product_id: { type: Sequelize.UUID, allowNull: false, primaryKey: true, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      other_product_id: { type: Sequelize.UUID, allowNull: false, primaryKey: true, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      // Orders holding both products in the window.
      orders_count: { type: Sequelize.INTEGER, allowNull: false },
      computed_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('product_affinities', ['workspace_id', 'product_id', 'orders_count'], { name: 'product_affinities_lookup_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('product_affinities');
  },
};
