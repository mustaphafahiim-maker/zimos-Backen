'use strict';

const { guarded } = require('../migrationGuards');

/**
 * What outbound order webhooks (modules/webhooks) need beyond the
 * webhook_endpoints / webhook_deliveries tables 054 and 055 already created.
 *
 * Order state is written by several modules — the confirmation queue, the
 * payments module, the courier sync and webhooks, the dashboard — through
 * orders/orderStateService.js and the shipment lifecycle. Rather than add a
 * call into each of those writers, the webhook module *observes*: it reads the
 * orders and shipments whose updated_at moved since its last look, derives
 * each one's state the same way the orders screen does (orders/orderStage.js)
 * and compares it with what it saw last time. A difference is an event. That
 * keeps every existing writer untouched, and it catches a change whichever
 * path made it.
 *
 * webhook_order_states: the last state the observer saw for one order —
 * `signature` is the compact form it compares, `state` the readable one sent
 * as `previous` in the next event. One row per order that has ever been seen
 * while its workspace had a webhook endpoint.
 *
 * webhook_scan_cursors: how far through updated_at the observer has read.
 * One row per scanner (today only 'orders'); the row is also the lock that
 * keeps two scanners — the in-process loop and the cron script — from reading
 * the same window at once.
 *
 * The indexes: the observer's two range scans (orders and shipments by
 * updated_at), and the dispatcher's "what is due" scan over deliveries.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await queryInterface.createTable('webhook_order_states', {
      order_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      signature: { type: DataTypes.STRING(200), allowNull: false },
      state: { type: DataTypes.JSONB, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('webhook_order_states', ['workspace_id'], {
      name: 'webhook_order_states_workspace_id_idx',
    });

    await queryInterface.createTable('webhook_scan_cursors', {
      name: { type: DataTypes.STRING(50), primaryKey: true, allowNull: false },
      scanned_until: { type: DataTypes.DATE, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('orders', ['updated_at'], { name: 'orders_updated_at_idx' });
    await queryInterface.addIndex('shipments', ['updated_at'], { name: 'shipments_updated_at_idx' });
    await queryInterface.addIndex('webhook_deliveries', ['status', 'next_attempt_at'], {
      name: 'webhook_deliveries_due_idx',
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeIndex('webhook_deliveries', 'webhook_deliveries_due_idx');
    await queryInterface.removeIndex('shipments', 'shipments_updated_at_idx');
    await queryInterface.removeIndex('orders', 'orders_updated_at_idx');
    await queryInterface.dropTable('webhook_scan_cursors');
    await queryInterface.dropTable('webhook_order_states');
  },
};
