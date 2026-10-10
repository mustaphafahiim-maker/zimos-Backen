'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Back-in-stock alerts (modules/stockAlerts, STORE_FEATURES stock_alerts): a
 * shopper leaves an email or phone on a sold-out variant and is told once
 * when it can be bought again. A new table, skipped when present; channel
 * and status are VARCHAR + CHECK.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const created = await qi.createTable('stock_alerts', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      product_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      variant_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'product_variants', key: 'id' }, onDelete: 'CASCADE' },
      // email | sms
      channel: { type: Sequelize.STRING(10), allowNull: false },
      target: { type: Sequelize.STRING(255), allowNull: false },
      locale: { type: Sequelize.STRING(5), allowNull: true },
      // waiting | notified
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'waiting' },
      notified_at: { type: Sequelize.DATE, allowNull: true },
      request_ip: { type: Sequelize.STRING(45), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    if (created) {
      await queryInterface.sequelize.query("ALTER TABLE stock_alerts ADD CONSTRAINT stock_alerts_channel_check CHECK (channel IN ('email', 'sms'))");
      await queryInterface.sequelize.query("ALTER TABLE stock_alerts ADD CONSTRAINT stock_alerts_status_check CHECK (status IN ('waiting', 'notified'))");
    }
    // One waiting alert per variant and address.
    await qi.addIndex('stock_alerts', ['variant_id', 'target'], { name: 'stock_alerts_waiting_unique', unique: true, where: { status: 'waiting' } });
    await qi.addIndex('stock_alerts', ['workspace_id', 'status'], { name: 'stock_alerts_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('stock_alerts');
  },
};
