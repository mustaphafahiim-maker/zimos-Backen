'use strict';

/**
 * Suppliers, purchase orders and stock counts (modules/purchasing, spec-gaps
 * item 207).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const ts = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    };
    const ws = { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' };
    await queryInterface.createTable('suppliers', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: ws,
      name: { type: Sequelize.STRING(160), allowNull: false },
      contact_name: { type: Sequelize.STRING(120), allowNull: true },
      phone: { type: Sequelize.STRING(40), allowNull: true },
      email: { type: Sequelize.STRING(255), allowNull: true },
      address: { type: Sequelize.STRING(300), allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      ...ts,
    });
    await queryInterface.addIndex('suppliers', ['workspace_id'], { name: 'suppliers_ws_idx' });
    await queryInterface.createTable('purchase_orders', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: ws,
      number: { type: Sequelize.STRING(20), allowNull: false },
      supplier_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'suppliers', key: 'id' }, onDelete: 'RESTRICT' },
      // draft | ordered | partially_received | received | cancelled
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'draft' },
      location_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_locations', key: 'id' }, onDelete: 'SET NULL' },
      currency: { type: Sequelize.STRING(3), allowNull: false },
      expected_at: { type: Sequelize.DATEONLY, allowNull: true },
      note: { type: Sequelize.STRING(500), allowNull: true },
      ordered_at: { type: Sequelize.DATE, allowNull: true },
      received_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      ...ts,
    });
    await queryInterface.addIndex('purchase_orders', ['workspace_id', 'number'], { name: 'purchase_orders_number_uq', unique: true });
    await queryInterface.createTable('purchase_order_lines', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      purchase_order_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'purchase_orders', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      quantity: { type: Sequelize.INTEGER, allowNull: false },
      received_quantity: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      unit_cost: { type: Sequelize.BIGINT, allowNull: false },
      ...ts,
    });
    await queryInterface.addIndex('purchase_order_lines', ['purchase_order_id'], { name: 'purchase_order_lines_po_idx' });
    await queryInterface.createTable('stock_counts', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: ws,
      location_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_locations', key: 'id' }, onDelete: 'SET NULL' },
      // open | applied | cancelled
      status: { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'open' },
      note: { type: Sequelize.STRING(300), allowNull: true },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.UUID, allowNull: true },
      ...ts,
    });
    await queryInterface.createTable('stock_count_lines', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      stock_count_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_counts', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      expected: { type: Sequelize.INTEGER, allowNull: false },
      counted: { type: Sequelize.INTEGER, allowNull: true },
      applied_delta: { type: Sequelize.INTEGER, allowNull: true },
      ...ts,
    });
    await queryInterface.addIndex('stock_count_lines', ['stock_count_id', 'variant_id'], { name: 'stock_count_lines_uq', unique: true });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('stock_count_lines');
    await queryInterface.dropTable('stock_counts');
    await queryInterface.dropTable('purchase_order_lines');
    await queryInterface.dropTable('purchase_orders');
    await queryInterface.dropTable('suppliers');
  },
};
