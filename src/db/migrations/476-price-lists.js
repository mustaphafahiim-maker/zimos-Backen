'use strict';

/**
 * Wholesale price lists (modules/priceLists, spec-gaps item 205): prices for
 * customers carrying given tags — a percentage off (all products or chosen
 * ones), or fixed variant prices with minimum quantities (tiers).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const ts = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    };
    await queryInterface.createTable('price_lists', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      customer_tags: { type: Sequelize.ARRAY(Sequelize.STRING(60)), allowNull: false, defaultValue: [] },
      // percent | fixed
      kind: { type: Sequelize.STRING(10), allowNull: false },
      percent: { type: Sequelize.INTEGER, allowNull: true },
      // percent lists: null = every product
      product_ids: { type: Sequelize.ARRAY(Sequelize.UUID), allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      ...ts,
    });
    await queryInterface.addIndex('price_lists', ['workspace_id'], { name: 'price_lists_ws_idx' });
    await queryInterface.createTable('price_list_prices', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      price_list_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'price_lists', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      min_quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      price_amount: { type: Sequelize.BIGINT, allowNull: false },
      ...ts,
    });
    await queryInterface.addIndex('price_list_prices', ['price_list_id', 'variant_id', 'min_quantity'], { name: 'price_list_prices_uq', unique: true });
    await queryInterface.addIndex('price_list_prices', ['variant_id'], { name: 'price_list_prices_variant_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('price_list_prices');
    await queryInterface.dropTable('price_lists');
  },
};
