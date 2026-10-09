'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A signed-in shopper's wishlist (modules/shopperAccounts/wishlist.js,
 * STORE_FEATURES shopper_accounts): one row per (customer, product, variant
 * or none). A new table, skipped when present.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.createTable('wishlist_items', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'customers', key: 'id' }, onDelete: 'CASCADE' },
      product_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'product_variants', key: 'id' }, onDelete: 'SET NULL' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    // NULLS NOT DISTINCT needs Postgres 15; a COALESCE index works everywhere.
    await queryInterface.sequelize.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS wishlist_items_unique ON wishlist_items (customer_id, product_id, (COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))"
    );
    await qi.addIndex('wishlist_items', ['workspace_id', 'product_id'], { name: 'wishlist_items_ws_product_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('wishlist_items');
  },
};
