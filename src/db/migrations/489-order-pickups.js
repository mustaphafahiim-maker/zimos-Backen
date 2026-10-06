'use strict';

/** Click and collect: an order picked up at a stock location (modules/clickAndCollect, spec-gaps item 225). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('order_pickups', {
      order_id: { type: Sequelize.UUID, primaryKey: true, references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      location_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_locations', key: 'id' }, onDelete: 'SET NULL' },
      // Kept at order time, so the record survives the location being renamed or removed.
      location_snapshot: { type: Sequelize.JSONB, allowNull: false },
      // Six digits the shopper shows when collecting.
      code: { type: Sequelize.STRING(8), allowNull: false },
      // pending | ready | collected | cancelled
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'pending' },
      ready_at: { type: Sequelize.DATE, allowNull: true },
      collected_at: { type: Sequelize.DATE, allowNull: true },
      collected_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('order_pickups', ['workspace_id', 'status', 'location_id'], { name: 'order_pickups_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('order_pickups');
  },
};
