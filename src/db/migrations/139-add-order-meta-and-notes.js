'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently } = require('../concurrentIndex');

/**
 * SPEC §4.2 — the order fields the orders screens organise by, and notes.
 *
 * orders.source       where the order came from: store | funnel | manual |
 *                     api | import | upsell. Existing orders are classified
 *                     from what they already record (a linked order is an
 *                     upsell, a funnel id is a funnel, an 'order.create'
 *                     audit row with a staff actor is manual).
 * orders.tags         free labels the merchant filters by.
 * orders.is_seen /    whether anyone has opened the order. Existing orders
 *   seen_at           count as seen: they are not news.
 * orders.is_test      placed by the merchant while previewing the store, or
 *                     marked by hand; kept out of sales figures and pixels.
 * orders.archived_at  "delete" for an order — it leaves the lists, nothing
 *                     is ever removed.
 *
 * order_notes: staff notes on an order. `visibility` 'internal' stays in the
 * dashboard; 'public' is shown to the customer on the tracking page.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    const addedSource = await queryInterface.addColumn('orders', 'source', { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'store' });
    await queryInterface.addColumn('orders', 'tags', {
      type: DataTypes.ARRAY(DataTypes.TEXT),
      allowNull: false,
      defaultValue: Sequelize.literal("'{}'::text[]"),
    });
    await queryInterface.addColumn('orders', 'is_seen', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('orders', 'seen_at', { type: DataTypes.DATE, allowNull: true });
    await queryInterface.addColumn('orders', 'is_test', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('orders', 'archived_at', { type: DataTypes.DATE, allowNull: true });

    // The backfills run only on the run that added the columns: a second run must not mark new orders seen.
    if (addedSource) {
      await queryInterface.sequelize.query(`UPDATE orders SET is_seen = TRUE, seen_at = created_at`);
      await queryInterface.sequelize.query(`UPDATE orders SET source = 'funnel' WHERE funnel_id IS NOT NULL`);
      await queryInterface.sequelize.query(
        `UPDATE orders o SET source = 'manual'
           FROM audit_logs a
          WHERE a.action = 'order.create' AND a.entity_type = 'Order'
            AND a.entity_id = o.id::text AND a.actor_user_id IS NOT NULL`
      );
      await queryInterface.sequelize.query(`UPDATE orders SET source = 'upsell' WHERE linked_from_order_id IS NOT NULL`);
    }

    await createIndexConcurrently(queryInterface, { name: 'orders_tags_gin_idx', table: 'orders', definition: `USING GIN (tags)` });
    await queryInterface.addIndex('orders', ['workspace_id', 'archived_at'], { name: 'orders_workspace_archived_idx' });
    await queryInterface.addIndex('orders', ['workspace_id', 'source'], { name: 'orders_workspace_source_idx' });

    await queryInterface.createTable('order_notes', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      body: { type: DataTypes.TEXT, allowNull: false },
      visibility: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'internal' },
      author_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('order_notes', ['order_id', 'created_at'], { name: 'order_notes_order_idx' });
    await queryInterface.addIndex('order_notes', ['workspace_id'], { name: 'order_notes_workspace_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('order_notes');
    await queryInterface.removeIndex('orders', 'orders_workspace_source_idx');
    await queryInterface.removeIndex('orders', 'orders_workspace_archived_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS orders_tags_gin_idx');
    for (const column of ['archived_at', 'is_test', 'seen_at', 'is_seen', 'tags', 'source']) {
      await queryInterface.removeColumn('orders', column);
    }
  },
};
