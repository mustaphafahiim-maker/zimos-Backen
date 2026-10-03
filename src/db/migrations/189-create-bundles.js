'use strict';

/**
 * Quantity bundles reusable across products (SPEC §10.1): "buy 2 and save
 * 5%, buy 3 and save 10%". A bundle has ordered tiers; a product points at
 * one bundle. The existing offers stay for single-product packs.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('bundles', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4, allowNull: false },
      workspace_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(200), allowNull: false },
      display_style: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'cards' },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('bundles', ['workspace_id'], { name: 'bundles_workspace' });

    await queryInterface.createTable('bundle_tiers', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4, allowNull: false },
      bundle_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'bundles', key: 'id' },
        onDelete: 'CASCADE',
      },
      position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      title: { type: Sequelize.STRING(200), allowNull: true },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      discount_type: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'percentage' },
      // percentage: percent × 100 (500 = 5%); fixed_price / fixed_amount_off:
      // minor units for the whole tier; buy_x_get_y: how many units are free.
      discount_value: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      label: { type: Sequelize.STRING(100), allowNull: true },
      sticker_text: { type: Sequelize.STRING(100), allowNull: true },
      sku: { type: Sequelize.STRING(100), allowNull: true },
      free_shipping: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('bundle_tiers', ['bundle_id', 'position'], { name: 'bundle_tiers_bundle_position' });

    await queryInterface.addColumn('products', 'bundle_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'bundles', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('products', ['bundle_id'], { name: 'products_bundle' });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('products', 'products_bundle');
    await queryInterface.removeColumn('products', 'bundle_id');
    await queryInterface.dropTable('bundle_tiers');
    await queryInterface.dropTable('bundles');
  },
};
