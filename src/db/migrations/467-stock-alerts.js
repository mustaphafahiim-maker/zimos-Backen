'use strict';

/**
 * Back-in-stock alerts (modules/stockAlerts, spec-gaps item 194): a shopper
 * leaves an email or phone on a sold-out variant and is told once when it
 * can be bought again.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('stock_alerts', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      product_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      channel: { type: Sequelize.STRING(10), allowNull: false },
      target: { type: Sequelize.STRING(255), allowNull: false },
      locale: { type: Sequelize.STRING(5), allowNull: true },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'waiting' },
      notified_at: { type: Sequelize.DATE, allowNull: true },
      request_ip: { type: Sequelize.STRING(45), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    // One waiting alert per variant and address.
    await queryInterface.addIndex('stock_alerts', ['variant_id', 'target'], { name: 'stock_alerts_waiting_unique', unique: true, where: { status: 'waiting' } });
    await queryInterface.addIndex('stock_alerts', ['workspace_id', 'status'], { name: 'stock_alerts_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('stock_alerts');
  },
};
