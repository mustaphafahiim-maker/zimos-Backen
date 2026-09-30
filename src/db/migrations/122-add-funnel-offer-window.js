'use strict';

/**
 * Funnel upsells joined to the order they follow (funnels/funnelOfferMerge.js,
 * behind workspaces.settings.funnel_upsell_merge).
 *
 *  - confirmation_tasks.available_at: while it lies ahead, the task waits for
 *    the funnel's offer window to close and no agent may take it. Null — every
 *    task that exists, and every task of an order placed outside a funnel —
 *    is available at once, as today. Nothing indexes it: the queue already
 *    reads tasks by (workspace_id, status), and this narrows those rows.
 *
 *  - funnel_offer_acceptances: one row per (order, offer step) the shopper
 *    accepted — what makes a double tap, a retried request or a second session
 *    add the line once. `result` says where it went: 'merged' into the order
 *    (order_item_id) or 'separate', a linked order of its own
 *    (follow_on_order_id), when the order had already left the window. A new,
 *    empty table: its indexes need no CONCURRENTLY.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tasks = await queryInterface.describeTable('confirmation_tasks');
    if (!tasks.available_at) {
      await queryInterface.addColumn('confirmation_tasks', 'available_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));
    if (!tables.includes('funnel_offer_acceptances')) {
      await queryInterface.createTable('funnel_offer_acceptances', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
        workspace_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'workspaces', key: 'id' },
          onDelete: 'CASCADE',
        },
        order_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'orders', key: 'id' },
          onDelete: 'CASCADE',
        },
        funnel_id: { type: Sequelize.UUID, allowNull: true },
        session_id: { type: Sequelize.UUID, allowNull: true },
        step_key: { type: Sequelize.STRING(100), allowNull: false },
        offer_id: { type: Sequelize.UUID, allowNull: true },
        result: { type: Sequelize.STRING(16), allowNull: false },
        order_item_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'order_items', key: 'id' },
          onDelete: 'SET NULL',
        },
        follow_on_order_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'orders', key: 'id' },
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE funnel_offer_acceptances
           ADD CONSTRAINT funnel_offer_acceptances_result_check CHECK (result IN ('merged', 'separate'))`
      );
      await queryInterface.addIndex('funnel_offer_acceptances', ['order_id', 'step_key'], {
        unique: true,
        name: 'funnel_offer_acceptances_order_step_unique',
      });
      await queryInterface.addIndex('funnel_offer_acceptances', ['workspace_id', 'created_at'], {
        name: 'funnel_offer_acceptances_workspace_created_idx',
      });
    }
  },

  down: async (queryInterface) => {
    const tables = (await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName));
    if (tables.includes('funnel_offer_acceptances')) await queryInterface.dropTable('funnel_offer_acceptances');
    const tasks = await queryInterface.describeTable('confirmation_tasks');
    if (tasks.available_at) await queryInterface.removeColumn('confirmation_tasks', 'available_at');
  },
};
