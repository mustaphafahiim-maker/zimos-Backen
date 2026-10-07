'use strict';

/** Scheduled price changes: a sale with a start and an end (modules/priceSchedules, spec-gaps item 227). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('price_schedules', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(120), allowNull: false },
      // scheduled | active | ended | cancelled
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'scheduled' },
      starts_at: { type: Sequelize.DATE, allowNull: false },
      ends_at: { type: Sequelize.DATE, allowNull: true },
      // { type: 'variants' | 'products' | 'collection', ids: [uuid] }
      target: { type: Sequelize.JSONB, allowNull: false },
      // { mode: 'percent_off' | 'amount_off' | 'set_price', value }
      change: { type: Sequelize.JSONB, allowNull: false },
      // Show the price before the sale as the "was" price while it runs.
      show_was_price: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      reverted_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('price_schedules', ['status', 'starts_at'], { name: 'price_schedules_due_idx' });
    await queryInterface.addIndex('price_schedules', ['workspace_id', 'created_at'], { name: 'price_schedules_ws_idx' });

    // What the sale changed on each variant, so the end can put it back.
    await queryInterface.createTable('price_schedule_items', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      schedule_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'price_schedules', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      old_price: { type: Sequelize.BIGINT, allowNull: false },
      old_compare_at: { type: Sequelize.BIGINT, allowNull: true },
      new_price: { type: Sequelize.BIGINT, allowNull: false },
      new_compare_at: { type: Sequelize.BIGINT, allowNull: true },
      // applied | restored | kept (the team changed the price during the sale) | skipped (in another sale)
      state: { type: Sequelize.STRING(10), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('price_schedule_items', ['schedule_id'], { name: 'price_schedule_items_schedule_idx' });
    await queryInterface.addIndex('price_schedule_items', ['variant_id', 'state'], { name: 'price_schedule_items_variant_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('price_schedule_items');
    await queryInterface.dropTable('price_schedules');
  },
};
