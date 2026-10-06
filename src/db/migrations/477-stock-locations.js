'use strict';

/**
 * Multiple stock locations (modules/stockLocations, spec-gaps item 206).
 * - stock_locations: warehouses / shops; one is the default.
 * - location_stock: units on hand at a NON-default location. The default
 *   location holds the rest of the variant's stock_on_hand, so every existing
 *   stock path (orders, restocks, imports) keeps working unchanged.
 * - stock_transfers: units moved between locations.
 * - orders.stock_location_id: where an order ships from (null = default).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const ts = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    };
    await queryInterface.createTable('stock_locations', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      address: { type: Sequelize.STRING(300), allowNull: true },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      ...ts,
    });
    await queryInterface.addIndex('stock_locations', ['workspace_id'], { name: 'stock_locations_one_default', unique: true, where: { is_default: true } });
    await queryInterface.createTable('location_stock', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      location_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_locations', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      on_hand: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ...ts,
    });
    await queryInterface.addIndex('location_stock', ['location_id', 'variant_id'], { name: 'location_stock_uq', unique: true });
    await queryInterface.createTable('stock_transfers', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      from_location_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_locations', key: 'id' }, onDelete: 'CASCADE' },
      to_location_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_locations', key: 'id' }, onDelete: 'CASCADE' },
      lines: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      note: { type: Sequelize.STRING(300), allowNull: true },
      actor_user_id: { type: Sequelize.UUID, allowNull: true },
      ...ts,
    });
    await queryInterface.addIndex('stock_transfers', ['workspace_id', 'created_at'], { name: 'stock_transfers_ws_idx' });
    await queryInterface.addColumn('orders', 'stock_location_id', { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_locations', key: 'id' }, onDelete: 'SET NULL' });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'stock_location_id');
    await queryInterface.dropTable('stock_transfers');
    await queryInterface.dropTable('location_stock');
    await queryInterface.dropTable('stock_locations');
  },
};
