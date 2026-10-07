'use strict';

/** Stock lots with expiry dates (modules/stockLots, spec-gaps item 230). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('stock_lots', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      location_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_locations', key: 'id' }, onDelete: 'SET NULL' },
      lot_code: { type: Sequelize.STRING(60), allowNull: false },
      expires_on: { type: Sequelize.DATEONLY, allowNull: true },
      quantity_received: { type: Sequelize.INTEGER, allowNull: false },
      // Units of this lot still on the shelf: received − shipped − written off.
      quantity_remaining: { type: Sequelize.INTEGER, allowNull: false },
      purchase_order_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'purchase_orders', key: 'id' }, onDelete: 'SET NULL' },
      note: { type: Sequelize.STRING(300), allowNull: true },
      alerted_at: { type: Sequelize.DATE, allowNull: true },
      written_off_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('stock_lots', ['workspace_id', 'variant_id', 'expires_on'], { name: 'stock_lots_fefo_idx' });
    await queryInterface.addIndex('stock_lots', ['workspace_id', 'expires_on'], { name: 'stock_lots_expiry_idx' });

    // Which lots an order's units left from (first expiring, first out).
    await queryInterface.createTable('stock_lot_allocations', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      lot_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'CASCADE' },
      order_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('stock_lot_allocations', ['order_id'], { name: 'stock_lot_allocations_order_idx' });
    await queryInterface.addIndex('stock_lot_allocations', ['lot_id'], { name: 'stock_lot_allocations_lot_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('stock_lot_allocations');
    await queryInterface.dropTable('stock_lots');
  },
};
